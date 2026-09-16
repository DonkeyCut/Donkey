// A batch of editor commands as a durable job. A host with its own
// conversation — the ChatGPT app — sends typed tool calls with no model of
// ours in the loop; the worker container opens the project document into the
// editor store, runs each command through the same executor the chat uses,
// pushes the document back, and records one undo checkpoint for the batch.
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { liveJobCheck } from "./limits";
import { queueLeasedJob } from "./lease";
import { getProject } from "./projects";
import { err } from "./util";
import { wakeRenderWorker } from "./wake";

export const MAX_COMMANDS_PER_BATCH = 40;

export interface CommandCall {
  name: string;
  input: Record<string, unknown>;
}

export interface CommandJobSpec {
  commands: CommandCall[];
  /** A read: the document is opened and inspected, never pushed. */
  readOnly?: boolean;
  /** The undo history's name for this batch. */
  label?: string;
}

export interface CommandOutcome {
  name: string;
  ok: boolean;
  output?: unknown;
  error?: string;
}

/** What a commands job records in CutRenderJob.result. */
export interface CommandJobResult {
  results: CommandOutcome[];
  /** The document changed and was saved. */
  changed: boolean;
  /** The project version after the save, when one happened. */
  docVersion: string | null;
}

export async function queueCommands(
  userId: string,
  projectId: string,
  spec: CommandJobSpec
): Promise<{ id: string } | Response> {
  if (!(await getProject(userId, projectId))) return err("Project not found.", 404);
  if (!Array.isArray(spec.commands) || spec.commands.length === 0) return err("At least one command is required.", 400);
  if (spec.commands.length > MAX_COMMANDS_PER_BATCH) return err(`At most ${MAX_COMMANDS_PER_BATCH} commands per batch.`, 400);
  const capped = await liveJobCheck(userId);
  if (capped) return capped;
  if (spec.readOnly) {
    // A read never saves, so it runs beside whatever holds the write lease.
    const row = await prisma.cutRenderJob.create({
      data: { userId, projectId, kind: "commands", spec: spec as unknown as Prisma.InputJsonValue },
    });
    wakeRenderWorker();
    return { id: row.id };
  }
  return queueLeasedJob(userId, projectId, "commands", spec as unknown as Prisma.InputJsonValue);
}

export type JobRow = NonNullable<Awaited<ReturnType<typeof prisma.cutRenderJob.findFirst>>>;

const HEARTBEAT_QUIET_MS = 30_000;

/** The row is waiting to be claimed, or its worker's heartbeat went quiet. */
export function needsWorker(row: Pick<JobRow, "state" | "claimedAt" | "updatedAt">): boolean {
  if (row.state === "queued") return true;
  return row.state === "running" && row.claimedAt !== null && Date.now() - row.updatedAt.getTime() > HEARTBEAT_QUIET_MS;
}

const TERMINAL = new Set(["done", "error", "canceled", "dismissed"]);

/** Poll a job row until it settles or the budget runs out. The row comes back
 * either way; the caller reads its state. */
export async function waitForJob(userId: string, jobId: string, budgetMs: number): Promise<JobRow | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const row = await prisma.cutRenderJob.findFirst({ where: { id: jobId, userId } });
    if (!row) return null;
    if (TERMINAL.has(row.state)) return row;
    if (needsWorker(row)) wakeRenderWorker();
    if (Date.now() >= deadline) return row;
    await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(50, deadline - Date.now()))));
  }
}
