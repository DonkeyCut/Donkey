#!/usr/bin/env bun
/**
 * Turn-as-job smoke: the close-the-tab test. Seeds a cloud project, POSTs a
 * chat turn to the turns route, and then only polls — the worker claims the
 * job, runs the headless turn, pushes the doc, and records the thread. The
 * script asserts the stored document and thread both carry the result.
 *
 * Run with the site dev server up and a local worker running:
 *   bun run scripts/eval-cut-turn-job.ts [--base http://localhost:3000]
 * (worker: `bun src/cut/worker/main.ts` from site/, .env supplies DATABASE_URL)
 */

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const base = arg("base") ?? "http://localhost:3000";
// --voiceover runs the media-generation variant: the turn synthesizes speech
// through the hosted TTS route and lands the audio in the project — the
// whole generation chain (hosted call, upload, probe, placement) headless.
const voiceover = process.argv.includes("--voiceover");
const headers = {
  "Content-Type": "application/json",
  "x-donkey-client-id": "donkey-cut-eval",
  "x-donkey-dev-auth-bypass": "1",
};
const api = (path: string, init?: RequestInit) => fetch(base + path, { headers, ...init && { ...init, headers: { ...headers, ...init.headers } } });
const fail = (msg: string): never => {
  // Throw so the seeded project's finally-block DELETE still runs; the
  // exit code carries the failure.
  process.exitCode = 1;
  throw new Error(`FAIL ${msg}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const created = await api("/api/cut-cloud/projects", {
  method: "POST",
  body: JSON.stringify({ name: `turn-job-eval-${Date.now()}` }),
});
if (!created.ok) fail(`could not create project (${created.status}) — is the dev server up?`);
const projectId = ((await created.json()) as { id: string }).id;
console.log(`seeded project ${projectId}`);

try {
  const threadId = `thread-${Date.now()}`;
  const ask = voiceover
    ? 'Generate a voiceover that says "Donkey headless test" and place it at the very start.'
    : 'Add a title that says "TURNJOB" at the very start of the video.';
  const queued = await api(`/api/cut-cloud/projects/${projectId}/turns`, {
    method: "POST",
    body: JSON.stringify({
      threadId,
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: ask }] }],
    }),
  });
  if (!queued.ok) fail(`could not queue turn (${queued.status}): ${await queued.text()}`);
  const jobId = ((await queued.json()) as { jobId: string }).jobId;
  console.log(`queued turn job ${jobId} — waiting on the worker`);

  const deadline = Date.now() + 180_000;
  let last = "";
  for (;;) {
    if (Date.now() > deadline) fail("turn job did not settle in 180s — is the worker running?");
    const res = await api(`/api/cut-cloud/jobs/${jobId}`);
    if (!res.ok) fail(`job poll failed (${res.status})`);
    const job = (await res.json()) as { state: string; progress: number; error?: string; result?: { reply?: string; toolCalls?: string[] } };
    const line = `${job.state} ${Math.round(job.progress * 100)}%`;
    if (line !== last) console.log(`  ${line}`);
    last = line;
    if (job.state === "error") fail(`turn job failed: ${job.error}`);
    if (job.state === "canceled") fail("turn job was canceled");
    if (job.state === "done") {
      console.log(`reply: ${(job.result?.reply ?? "").slice(0, 200)}`);
      console.log(`tools: [${(job.result?.toolCalls ?? []).join(", ")}]`);
      break;
    }
    await sleep(1500);
  }

  const readBack = await api(`/api/cut-cloud/projects/${projectId}`);
  if (!readBack.ok) fail(`could not re-read project (${readBack.status})`);
  const stored = (await readBack.json()) as {
    overlays?: { text?: unknown; start?: number }[];
    audioClips?: { assetId: string; start: number }[];
    assets?: { id: string; type: string; duration: number }[];
  };
  if (voiceover) {
    const clip = (stored.audioClips ?? [])[0];
    if (!clip) fail("no soundtrack clip in the stored doc");
    const asset = (stored.assets ?? []).find((a) => a.id === clip!.assetId);
    if (!asset || asset.type !== "audio" || !(asset.duration > 0))
      fail(`the clip's asset is missing or empty: ${JSON.stringify(asset)}`);
    console.log(`stored doc carries a ${asset!.duration.toFixed(1)}s voiceover at ${clip!.start}s`);
  } else {
    const title = (stored.overlays ?? []).find(
      (o) => typeof o.text === "string" && o.text.toUpperCase().includes("TURNJOB")
    );
    if (!title) fail(`no TURNJOB title in the stored doc — overlays: ${JSON.stringify(stored.overlays)}`);
    console.log(`stored doc carries the title at ${title!.start}s`);
  }

  const chats = await api(`/api/cut-cloud/projects/${projectId}/chats`);
  if (!chats.ok) fail(`could not read chats (${chats.status})`);
  const thread = ((await chats.json()) as { id: string; messages?: { role: string }[] }[]).find(
    (t) => t.id === threadId
  );
  if (!thread) fail("the turn's thread was not recorded");
  const roles = (thread.messages ?? []).map((m) => m.role);
  if (!roles.includes("user") || !roles.includes("assistant"))
    fail(`thread misses a side of the exchange: [${roles.join(", ")}]`);
  console.log(`PASS thread recorded with [${roles.join(", ")}]`);
} finally {
  await api(`/api/cut-cloud/projects/${projectId}`, { method: "DELETE" });
}
