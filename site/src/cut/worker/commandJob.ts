import { assetFromProjectFile } from "../lib/media";
import { bindHeadlessSession } from "../lib/headless/bind";
import { openCloudProject, ProjectConflictError, pushCloudProject, type HeadlessDocSession } from "../lib/headless/docSession";
import { headlessDeps, type HeadlessSession } from "../lib/pi/serverDeps";
import { serializeDoc, useEditor } from "../lib/store";
import type { CommandJobResult, CommandJobSpec, CommandOutcome } from "../server/cloud/commands";
import { recordCheckpoint } from "../server/cloud/history";
import type { RenderHandle } from "../server/exportPipeline";
import { prisma, type ClaimedJob } from "./db";
import { runnerSession } from "./session";

// A command batch, executed where the tab used to be: open the project
// document into the editor store, run each typed command through the chat's
// own executor, push the document back through the versioned PUT, and record
// the batch as one undo checkpoint. No model runs here — the caller decided
// what to do; this process does it.

/** Contact sheets, captured frames and listened audio ride in the result as
 * data URLs. Past this much, later ones are dropped and say so, so one batch
 * never writes a row the poll cannot read. */
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

/** How many times an adoption re-opens the document after losing the
 * versioned PUT to a parallel import. */
const ADOPT_ATTEMPTS = 5;

const snapshot = () => JSON.stringify(serializeDoc(useEditor.getState()));

/** Save the store's edits under the session's version and record the step.
 * The checkpoint holds the document as the PUT stored it — the server
 * normalizes what it receives, so the checkpoint reads the row back. */
async function saveStep(
  session: HeadlessSession,
  userId: string,
  doc: HeadlessDocSession,
  label: string
): Promise<string> {
  const before = { doc: doc.doc, version: Number(doc.version) };
  await pushCloudProject(session, doc);
  const stored = await prisma.cutProject.findFirst({
    where: { id: doc.projectId, userId },
    select: { doc: true, version: true },
  });
  if (!stored) throw new Error("The project is gone after the save.");
  await recordCheckpoint(prisma, {
    userId,
    projectId: doc.projectId,
    before,
    after: { doc: stored.doc as unknown as HeadlessDocSession["doc"], version: stored.version },
    label,
  });
  return String(stored.version);
}

/** Keep the batch's inline media (frames, sheets, listened audio) inside one
 * result budget. */
function boundMedia(results: CommandOutcome[]): void {
  let budget = MAX_MEDIA_BYTES;
  const take = (url: unknown): unknown => {
    if (typeof url !== "string" || !url.startsWith("data:")) return url;
    if (url.length <= budget) {
      budget -= url.length;
      return url;
    }
    return "[dropped: the batch's inline media exceeds the result budget — ask for this in its own call]";
  };
  for (const r of results) {
    const out = r.output as { image?: unknown; images?: unknown[]; audio?: unknown } | null;
    if (!out || typeof out !== "object") continue;
    if ("image" in out) out.image = take(out.image);
    if (Array.isArray(out.images)) out.images = out.images.map(take);
    if ("audio" in out) out.audio = take(out.audio);
  }
}

export async function runCommandJob(
  job: ClaimedJob,
  handle: RenderHandle,
  isCanceled: () => boolean
): Promise<CommandJobResult> {
  const spec = job.spec as CommandJobSpec;
  if (!job.projectId) throw new Error("Command job carries no project.");
  if (!Array.isArray(spec?.commands) || spec.commands.length === 0)
    throw new Error("Command job carries no commands.");

  const session = runnerSession(job);
  bindHeadlessSession(session);
  const doc = await openCloudProject(session, job.projectId);
  const deps = headlessDeps(session);
  const before = snapshot();
  const results: CommandOutcome[] = [];
  for (const [i, call] of spec.commands.entries()) {
    if (isCanceled()) throw new Error("Canceled.");
    handle.progress = i / spec.commands.length;
    try {
      const output = await deps.execTool(call.name, call.input ?? {});
      results.push({ name: call.name, ok: true, output: output ?? null });
    } catch (err) {
      // The batch stops at the first failure: later commands assumed this
      // one landed. The caller sees exactly how far it got.
      results.push({ name: call.name, ok: false, error: err instanceof Error ? err.message : String(err) });
      break;
    }
  }
  boundMedia(results);
  const changed = snapshot() !== before;
  let docVersion: string | null = null;
  if (changed && !spec.readOnly) {
    const label = spec.label?.trim() || results.filter((r) => r.ok).map((r) => r.name).join(", ") || "Edit";
    docVersion = await saveStep(session, job.userId, doc, label);
  }
  handle.progress = 1;
  return { results, changed: changed && !spec.readOnly, docVersion };
}

/** Register files an import landed as project assets and save the document:
 * the adoption a tab does after its own import, done here for a caller with
 * no tab. Returns the assets as the catalog's import reports them. */
export async function adoptImportedFiles(
  job: ClaimedJob,
  files: { fileName: string; title: string }[],
  name?: string
): Promise<{ assets: { assetId: string; name: string; kind: string; duration: number }[]; docVersion: string }> {
  if (!job.projectId) throw new Error("Import job carries no project.");
  const session = runnerSession(job);
  bindHeadlessSession(session);
  // Parallel imports into one project each add their own assets; the loser
  // of the versioned PUT re-opens the newer document and adds them again.
  for (let attempt = 1; ; attempt++) {
    const doc = await openCloudProject(session, job.projectId);
    const assets: { assetId: string; name: string; kind: string; duration: number }[] = [];
    for (const f of files) {
      const asset = await assetFromProjectFile(job.projectId, f.fileName, (files.length === 1 && name) || f.title || f.fileName);
      useEditor.getState().addAsset(asset);
      assets.push({ assetId: asset.id, name: asset.name, kind: asset.type, duration: Math.round(asset.duration * 100) / 100 });
    }
    try {
      const docVersion = await saveStep(session, job.userId, doc, `Imported ${assets.map((a) => a.name).join(", ")}`);
      return { assets, docVersion };
    } catch (err) {
      if (!(err instanceof ProjectConflictError) || attempt >= ADOPT_ATTEMPTS) throw err;
    }
  }
}
