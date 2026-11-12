import { runCommandBatch, type CommandJobResult, type CommandJobSpec } from "../lib/commandBatch";
import { openCloudProject, pushCloudProject } from "../lib/headless/docSession";
import { headlessDeps } from "../lib/pi/serverDeps";
import { projectRevision } from "../lib/projectRevision";
import { serializeDoc, useEditor } from "../lib/store";
import type { RenderHandle } from "../server/exportPipeline";
import type { ClaimedJob } from "./db";
import { runnerSession } from "./session";

// A command batch no card claimed: a host with no card open (Codex, a closed
// ChatGPT card) sent it. Open the saved project into the editor store, run
// each command through the same executors the card and the chat use, and save
// through the versioned PUT. No model runs here; the caller decided what to do.

const snapshot = () => JSON.stringify(serializeDoc(useEditor.getState()));

export async function runCommandJob(
  job: ClaimedJob,
  handle: RenderHandle,
  isCanceled: () => boolean
): Promise<CommandJobResult> {
  const spec = job.spec as CommandJobSpec;
  if (!job.projectId) throw new Error("Command job carries no project.");
  if (!Array.isArray(spec?.commands) || spec.commands.length === 0) throw new Error("Command job carries no commands.");

  // The same runner the card uses, fed by the headless executors.
  const session = runnerSession(job);
  const doc = await openCloudProject(session, job.projectId);
  const deps = headlessDeps(session);
  const before = snapshot();
  const results = await runCommandBatch(job.projectId, spec.commands, (name, input) => deps.execTool(name, input), {
    isCanceled,
    onProgress: (fraction) => {
      handle.progress = fraction;
    },
  });

  // A read never saves; an edit saves once, as the card's batch does.
  const changed = !spec.readOnly && snapshot() !== before;
  if (!changed) {
    return { results, changed: false, docVersion: null };
  }
  await pushCloudProject(session, doc);
  return { results, changed: true, docVersion: projectRevision(job.projectId) };
}
