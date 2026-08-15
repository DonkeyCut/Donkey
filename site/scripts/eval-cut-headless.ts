#!/usr/bin/env bun
/**
 * Headless turn smoke: one real chat turn through the production loop with no
 * page attached. Seeds a cloud project on the dev server, opens its document
 * into the editor store, runs streamCutChat on the headless deps, pushes the
 * store back through the versioned PUT, and asserts the edit landed in the
 * stored document.
 *
 * Run with the site dev server up:
 *   bun run scripts/eval-cut-headless.ts [--base http://localhost:3000] [--keep]
 *
 * Auth is the dev bypass header (a scripts-only grant), so runs are
 * dev-server-only and spend no credits beyond the model call.
 */

import type { UIMessage } from "ai";
import { openCloudProject, pushCloudProject } from "../src/cut/lib/headless/docSession";
import { dropPiSession, streamCutChat } from "../src/cut/lib/pi/cutAgent";
import { headlessDeps, type HeadlessSession } from "../src/cut/lib/pi/serverDeps";
import { geminiModelRoles } from "../src/lib/inference/gemini-models";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const base = arg("base") ?? "http://localhost:3000";
const keep = process.argv.includes("--keep");

const session: HeadlessSession = {
  base,
  headers: {
    "x-donkey-client-id": "donkey-cut-eval",
    "x-donkey-dev-auth-bypass": "1",
  },
};

const api = (path: string, init?: RequestInit) =>
  fetch(base + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...session.headers, ...init?.headers },
  });

const fail = (msg: string): never => {
  // Throw so the seeded project's finally-block DELETE still runs; the
  // exit code carries the failure.
  process.exitCode = 1;
  throw new Error(`FAIL ${msg}`);
};

// 1) Seed an empty cloud project.
const created = await api("/api/cut-cloud/projects", {
  method: "POST",
  body: JSON.stringify({ name: `headless-eval-${Date.now()}` }),
});
if (!created.ok) fail(`could not create project (${created.status}) — is the dev server up?`);
const projectId = ((await created.json()) as { id: string }).id;
console.log(`seeded project ${projectId}`);

try {
  // 2) Open its doc into the editor store.
  const doc = await openCloudProject(session, projectId);
  console.log(`opened at version ${doc.version}`);

  // 3) One real edit turn through the production loop.
  const ask = 'Add a title that says "HEADLESS" at the very start of the video.';
  const messages = [
    { id: "m1", role: "user", parts: [{ type: "text", text: ask }] },
  ] as unknown as UIMessage[];
  const threadId = `headless-eval-${projectId}`;
  const calls: string[] = [];
  const deps = headlessDeps(session);
  const exec = deps.execTool;
  deps.execTool = async (name, args) => {
    calls.push(name);
    return exec(name, args);
  };

  let reply = "";
  let streamError: string | null = null;
  const reader = streamCutChat({
    threadId,
    model: geminiModelRoles.chat,
    messages,
    deps,
  }).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value as unknown as { type: string; delta?: string; errorText?: string };
      if (chunk.type === "text-delta" && chunk.delta) reply += chunk.delta;
      if (chunk.type === "error" && chunk.errorText) streamError = chunk.errorText;
    }
  } finally {
    dropPiSession(threadId);
  }
  if (streamError) fail(`stream error: ${streamError}`);
  console.log(`turn ran ${calls.length} tool calls [${calls.join(", ")}]`);
  console.log(`reply: ${reply.trim().slice(0, 200)}`);

  // 4) Push the store back up and re-read the stored document.
  const openedVersion = doc.version;
  const pushed = await pushCloudProject(session, doc);
  console.log(`pushed as version ${pushed.version}`);
  if (pushed.version === openedVersion) fail("the versioned PUT did not advance the doc version");
  const readBack = await api(`/api/cut-cloud/projects/${projectId}`);
  if (!readBack.ok) fail(`could not re-read project (${readBack.status})`);
  const stored = (await readBack.json()) as {
    overlays?: { text?: unknown; start?: number }[];
  };
  const title = (stored.overlays ?? []).find(
    (o) => typeof o.text === "string" && o.text.toUpperCase().includes("HEADLESS")
  );
  if (!title) fail(`no HEADLESS title in the stored doc — overlays: ${JSON.stringify(stored.overlays)}`);
  console.log(`PASS stored doc carries the title at ${title!.start}s`);
} finally {
  if (!keep) await api(`/api/cut-cloud/projects/${projectId}`, { method: "DELETE" });
}
