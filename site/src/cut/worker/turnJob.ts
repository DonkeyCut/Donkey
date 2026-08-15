import type { UIMessage } from "ai";
import { geminiModelRoles } from "@/lib/inference/gemini-models";
import { openCloudProject, pushCloudProject } from "../lib/headless/docSession";
import { CUT_HOSTED_ORIGIN } from "../lib/hosts";
import { dropPiSession, streamCutChat } from "../lib/pi/cutAgent";
import { headlessDeps, type HeadlessSession } from "../lib/pi/serverDeps";
import type { RenderHandle } from "../server/exportPipeline";
import type { AgentTurnSpec } from "../server/cloud/turns";
import type { ClaimedJob } from "./db";

// An agent turn, executed where the tab used to be: open the project doc into
// the editor store, run the production chat loop with the headless deps, push
// the doc back through the versioned PUT, and record the finished exchange on
// the project's stored thread. Every hosted call rides the runner grant — the
// shared secret plus the job's user — so the turn spends that user's credits
// and writes that user's project, exactly as the page would.

const CLIENT_ID = "donkey-cut-runner";

/** A stored thread as the AI panel keeps it; the runner appends whole
 * messages and touches nothing else in the payload. */
interface StoredThreadPayload {
  id: string;
  title?: string;
  updatedAt?: number;
  messages?: unknown[];
  [key: string]: unknown;
}

function runnerSession(job: ClaimedJob): HeadlessSession {
  const secret = process.env.CUT_RUNNER_SECRET;
  if (secret)
    return {
      base: CUT_HOSTED_ORIGIN,
      headers: {
        "x-donkey-client-id": CLIENT_ID,
        "x-donkey-runner-secret": secret,
        "x-donkey-runner-user": job.userId,
      },
    };
  if (process.env.NODE_ENV === "production")
    throw new Error("CUT_RUNNER_SECRET is not set — the runner cannot call the hosted API.");
  // A dev worker run by hand against the dev server: the bypass grant, the
  // same one the eval scripts use.
  return {
    base: CUT_HOSTED_ORIGIN,
    headers: { "x-donkey-client-id": CLIENT_ID, "x-donkey-dev-auth-bypass": "1" },
  };
}

/** Record the finished exchange on the project's stored thread: the turn's
 * own messages plus the assistant reply, merged over whatever the thread
 * already holds so a re-run never duplicates history. */
async function recordThread(
  s: HeadlessSession,
  projectId: string,
  spec: AgentTurnSpec,
  jobId: string,
  reply: string
): Promise<void> {
  const url = `${s.base}/api/cut-cloud/projects/${encodeURIComponent(projectId)}/chats/${encodeURIComponent(spec.threadId)}`;
  const listRes = await fetch(
    `${s.base}/api/cut-cloud/projects/${encodeURIComponent(projectId)}/chats`,
    { headers: s.headers }
  );
  // The PUT below replaces the thread wholesale, so writing on a failed read
  // would erase the stored history. Fail the record step; the job surfaces
  // the error rather than losing a conversation.
  if (!listRes.ok) throw new Error(`Could not read the project's chats (${listRes.status}).`);
  const stored: StoredThreadPayload | undefined = ((await listRes.json()) as StoredThreadPayload[]).find(
    (t) => t?.id === spec.threadId
  );
  const known = new Set(
    (stored?.messages ?? [])
      .map((m) => (m && typeof m === "object" ? String((m as { id?: unknown }).id ?? "") : ""))
      .filter(Boolean)
  );
  const fresh = (spec.messages as { id?: string }[]).filter((m) => !known.has(String(m?.id ?? "")));
  const firstText = (spec.messages as UIMessage[])
    .filter((m) => m.role === "user")
    .flatMap((m) => m.parts ?? [])
    .find((p) => p.type === "text" && p.text.trim());
  const payload: StoredThreadPayload = {
    ...(stored ?? {}),
    id: spec.threadId,
    title: stored?.title ?? (firstText?.type === "text" ? firstText.text.slice(0, 60) : "Chat"),
    updatedAt: Date.now(),
    messages: [
      ...(stored?.messages ?? []),
      ...fresh,
      {
        id: `turn-${jobId}`,
        role: "assistant",
        parts: [{ type: "text", text: reply }],
      },
    ],
  };
  const put = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...s.headers },
    body: JSON.stringify(payload),
  });
  if (!put.ok) throw new Error(`Could not record the thread (${put.status}).`);
}

export interface TurnResult {
  reply: string;
  toolCalls: string[];
  docVersion: string | null;
}

export async function runTurnJob(
  job: ClaimedJob,
  handle: RenderHandle,
  isCanceled: () => boolean
): Promise<TurnResult> {
  const spec = job.spec as AgentTurnSpec;
  if (!job.projectId) throw new Error("Turn job carries no project.");
  if (!spec?.threadId || !Array.isArray(spec.messages))
    throw new Error("Turn job carries no thread payload.");

  const session = runnerSession(job);
  const doc = await openCloudProject(session, job.projectId);

  const deps = headlessDeps(session);
  const toolCalls: string[] = [];
  const exec = deps.execTool;
  deps.execTool = async (name, args) => {
    toolCalls.push(name);
    return exec(name, args);
  };
  let rounds = 0;
  deps.hooks = {
    onRound: () => {
      rounds += 1;
      // The row's progress bar: rounds settle asymptotically toward done.
      handle.progress = Math.min(0.9, rounds / 8);
    },
  };

  const piKey = `turn-${job.id}`;
  let reply = "";
  let streamError: string | null = null;
  // The abort tears the agent loop down for real on cancel — model call,
  // pending tool batch, and all. Without it a canceled reader leaves the loop
  // running detached while this process moves on to another user's job. The
  // poller fires it even while the loop is parked inside reader.read() on a
  // stalled stream, so a cancel always lands.
  const abort = new AbortController();
  const cancelPoll = setInterval(() => {
    if (isCanceled()) abort.abort();
  }, 1000);
  const reader = streamCutChat({
    threadId: piKey,
    model: spec.model ?? geminiModelRoles.chat,
    messages: spec.messages as UIMessage[],
    abortSignal: abort.signal,
    deps,
  }).getReader();
  try {
    for (;;) {
      if (isCanceled()) {
        abort.abort();
        await reader.cancel();
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value as unknown as { type: string; delta?: string; errorText?: string };
      if (chunk.type === "text-delta" && chunk.delta) reply += chunk.delta;
      else if (chunk.type === "text-start" && reply) reply += "\n";
      else if (chunk.type === "error" && chunk.errorText) streamError = chunk.errorText;
    }
  } finally {
    clearInterval(cancelPoll);
    dropPiSession(piKey);
  }
  if (streamError) throw new Error(streamError);
  if (isCanceled()) throw new Error("Canceled.");

  reply = reply.trim();
  await pushCloudProject(session, doc);
  await recordThread(session, job.projectId, spec, job.id, reply);
  handle.progress = 1;
  return { reply, toolCalls, docVersion: doc.version };
}
