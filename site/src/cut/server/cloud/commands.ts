// A batch of editor commands as a durable job. A host with its own
// conversation — the ChatGPT app — sends typed tool calls with no model of
// ours in the loop. The editor open in the ChatGPT card claims the batch,
// runs it on the document in front of the user through the same executors
// the chat uses, saves, and reports back. Nothing else runs a batch: one no
// card claims in time is dismissed, and the tool call says the project has to
// be open in the card.
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { CommandJobResult, CommandJobSpec, CommandOutcome } from "@/cut/lib/commandBatch";
import { needsWorker } from "./jobs";
import { liveJobCheck } from "./limits";
import { queueLeasedJob } from "./lease";
import { getProject } from "./projects";
import { err } from "./util";
import { wakeRenderWorker } from "./wake";

export type { CommandCall, CommandJobResult, CommandJobSpec, CommandOutcome } from "@/cut/lib/commandBatch";

export const MAX_COMMANDS_PER_BATCH = 40;

/** How long a claimed batch may go without a heartbeat before the editor
 * that claimed it counts as gone. The card beats every ten seconds. */
export const CLAIM_QUIET_MS = 30_000;

/** The answer a tool call gets when nothing claimed its batch. */
export const NO_CARD_OPEN = "No Donkey Cut card has this project open in the chat. Call open_project, then try again.";

export type JobRow = NonNullable<Awaited<ReturnType<typeof prisma.cutRenderJob.findFirst>>>;

const specOf = (row: Pick<JobRow, "spec">) => (row.spec ?? {}) as unknown as CommandJobSpec;
const specJson = (spec: CommandJobSpec) => spec as unknown as Prisma.InputJsonValue;
const resultJson = (result: CommandJobResult) => result as unknown as Prisma.InputJsonValue;

/** Batches whose editor stopped beating end here, so they never hold the
 * project's lease or a job slot. Runs on every queue and claim. */
async function expireQuietBatches(userId: string, projectId: string): Promise<void> {
  await prisma.cutRenderJob.updateMany({
    where: { userId, projectId, kind: "commands", state: "running", updatedAt: { lt: new Date(Date.now() - CLAIM_QUIET_MS) } },
    data: { state: "error", error: "The editor in the card stopped responding." },
  });
}

export async function queueCommands(
  userId: string,
  projectId: string,
  spec: CommandJobSpec
): Promise<{ id: string } | Response> {
  if (!(await getProject(userId, projectId))) return err("Project not found.", 404);
  if (!Array.isArray(spec.commands) || spec.commands.length === 0) return err("At least one command is required.", 400);
  if (spec.commands.length > MAX_COMMANDS_PER_BATCH) return err(`At most ${MAX_COMMANDS_PER_BATCH} commands per batch.`, 400);
  await expireQuietBatches(userId, projectId);
  const capped = await liveJobCheck(userId);
  if (capped) return capped;
  if (spec.readOnly) {
    // A read never saves, so it runs beside whatever holds the write lease.
    const row = await prisma.cutRenderJob.create({ data: { userId, projectId, kind: "commands", spec: specJson(spec) } });
    return { id: row.id };
  }
  // The card runs batches one after another, so they queue behind each
  // other and contend only with a chat turn editing the same document.
  return queueLeasedJob(userId, projectId, "commands", specJson(spec), { wake: false, contendsWith: ["agent_turn"] });
}

const TERMINAL = new Set(["done", "error", "canceled", "dismissed"]);

/** A queued batch older than the claim window: no card picked it up. The
 * window is measured from the row's age, the one clock the card's polling
 * and this wait share. */
const claimWindowClosed = (row: Pick<JobRow, "createdAt">, claimMs: number) =>
  Date.now() - row.createdAt.getTime() > claimMs;

async function dismissBatch(row: Pick<JobRow, "id">): Promise<void> {
  await prisma.cutRenderJob.updateMany({
    where: { id: row.id, state: "queued" },
    data: { state: "dismissed", error: NO_CARD_OPEN },
  });
}

async function expireBatch(row: Pick<JobRow, "id">): Promise<void> {
  await prisma.cutRenderJob.updateMany({
    where: { id: row.id, state: "running" },
    data: { state: "error", error: "The editor in the card stopped responding." },
  });
}

/** Poll a job row until it settles or the budget runs out. The row comes back
 * either way; the caller reads its state. A command batch no card claims
 * within `editorClaimMs` is dismissed; one whose editor stops beating ends
 * in error. Any other kind of job is the worker's, which is woken as needed. */
export async function waitForJob(
  userId: string,
  jobId: string,
  budgetMs: number,
  opts: { editorClaimMs?: number } = {}
): Promise<JobRow | null> {
  const deadline = Date.now() + budgetMs;
  const claimMs = opts.editorClaimMs ?? 3000;
  for (;;) {
    const row = await prisma.cutRenderJob.findFirst({ where: { id: jobId, userId } });
    if (!row) return null;
    if (TERMINAL.has(row.state)) return row;
    if (row.kind === "commands") {
      if (row.state === "queued" && claimWindowClosed(row, claimMs)) {
        await dismissBatch(row);
        continue;
      }
      if (row.state === "running" && Date.now() - row.updatedAt.getTime() > CLAIM_QUIET_MS) {
        await expireBatch(row);
        continue;
      }
    } else if (needsWorker(row)) {
      wakeRenderWorker();
    }
    if (Date.now() >= deadline) return row;
    await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(50, deadline - Date.now()))));
  }
}

/** The editor in the card asks for the project's oldest waiting batch. */
export async function claimEditorBatch(
  userId: string,
  projectId: string
): Promise<{ id: string; spec: CommandJobSpec } | null> {
  await expireQuietBatches(userId, projectId);
  const candidates = await prisma.cutRenderJob.findMany({
    where: { userId, projectId, kind: "commands", state: "queued" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, spec: true },
    take: 5,
  });
  for (const row of candidates) {
    const { count } = await prisma.cutRenderJob.updateMany({
      where: { id: row.id, state: "queued" },
      data: { state: "running", claimedAt: new Date(), progress: 0, error: null },
    });
    if (count === 1) return { id: row.id, spec: specOf(row) };
  }
  return null;
}

/** The editor keeps a claimed batch alive while it runs. False once the batch
 * is no longer running — expired, canceled — so the editor stops. */
export async function heartbeatEditorBatch(userId: string, jobId: string, progress: number | null): Promise<boolean> {
  const { count } = await prisma.cutRenderJob.updateMany({
    where: { id: jobId, userId, kind: "commands", state: "running" },
    data: { updatedAt: new Date(), ...(progress !== null ? { progress: Math.max(0, Math.min(1, progress)) } : {}) },
  });
  return count === 1;
}

export type EditorReport =
  | { ok: true; results: CommandOutcome[]; changed: boolean; docVersion: string | null }
  | { ok: false; error: string };

/** The editor reports a batch it ran. False when the batch is no longer
 * running, so a late report after an expiry changes nothing. */
export async function settleEditorBatch(userId: string, jobId: string, report: EditorReport): Promise<boolean> {
  const row = await prisma.cutRenderJob.findFirst({
    where: { id: jobId, userId, kind: "commands", state: "running" },
    select: { spec: true },
  });
  if (!row) return false;
  const data = report.ok
    ? {
        state: "done",
        progress: 1,
        result: resultJson({
          results: report.results,
          changed: report.changed && !specOf(row).readOnly,
          docVersion: report.changed ? report.docVersion : null,
        }),
      }
    : { state: "error", error: report.error.slice(0, 2000) };
  const { count } = await prisma.cutRenderJob.updateMany({ where: { id: jobId, state: "running" }, data });
  return count === 1;
}

const isOutcome = (r: unknown): r is CommandOutcome =>
  Boolean(r) && typeof r === "object" && typeof (r as CommandOutcome).name === "string" && typeof (r as CommandOutcome).ok === "boolean";

/** The editor's report, read out of the request body. */
function parseReport(body: unknown): EditorReport | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { ok?: unknown; results?: unknown; changed?: unknown; docVersion?: unknown; error?: unknown };
  if (b.ok === false) return { ok: false, error: typeof b.error === "string" ? b.error : "The editor could not run the batch." };
  if (!Array.isArray(b.results)) return null;
  return {
    ok: true,
    results: b.results.filter(isOutcome),
    changed: b.changed === true,
    docVersion: typeof b.docVersion === "string" ? b.docVersion : null,
  };
}

/** The routes the editor in the card uses to run batches. */
export const commandsCloud = {
  async claim(userId: string, projectId: string) {
    const claimed = await claimEditorBatch(userId, projectId);
    if (!claimed) return new Response(null, { status: 204 });
    return Response.json(claimed);
  },
  async heartbeat(userId: string, jobId: string, req: Request) {
    const body = (await req.json().catch(() => ({}))) as { progress?: unknown };
    const alive = await heartbeatEditorBatch(userId, jobId, typeof body.progress === "number" ? body.progress : null);
    return alive ? Response.json({ ok: true }) : err("Not a running batch.", 409);
  },
  async result(userId: string, jobId: string, req: Request) {
    const report = parseReport(await req.json().catch(() => null));
    if (!report) return err("Bad result.", 400);
    const settled = await settleEditorBatch(userId, jobId, report);
    return settled ? Response.json({ ok: true }) : err("Not a running batch.", 409);
  },
};
