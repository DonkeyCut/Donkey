#!/usr/bin/env bun
/**
 * The Cut queue triage eval: where a message sent mid-turn goes.
 *
 * Each case is a running turn plus the messages the user sent while it ran,
 * placed by the production triage call — fold into the running turn, spawn
 * a parallel thread, or wait in the tray — and checked against the place
 * each message must get. A wrong fold does the work in the wrong turn, a
 * wrong spawn runs two agents over the same clips, and a wrong queue makes
 * the user wait; every case pins one of those lines.
 *
 * The live fold case then runs a real turn through the production loop and
 * folds a message into it mid-turn, the way the page does: the fold has to
 * land in the turn's context and the turn has to act on it.
 *
 * Run with the site dev server up:
 *   bun run scripts/eval-cut-queue.ts
 *     [--base http://localhost:3000]
 *     [--only <case>[,<case>…]]
 *     [--runs N]                      default 1; 3+ shows a flaky verdict
 *     [--gate-model <registryKey|rawId>]
 *     [--no-live]                     skip the live fold turn
 *
 * Auth is the dev bypass header (scripts only — never the app), so runs are
 * dev-server-only and spend no credits.
 */

import type { UIMessage } from "ai";
import type { Message } from "@earendil-works/pi-ai";
import { geminiModelRoleNames, geminiModels, resolveGeminiModel } from "../src/lib/inference/gemini-models";
import {
  dropPiSession,
  foldIntoCutChat,
  readPiSession,
  streamCutChat,
  triageQueuedMessages,
  type CutAgentDeps,
} from "../src/cut/lib/pi/cutAgent";
import type { QueueVerdict } from "../src/cut/lib/queueTriage";
import { AUDIO_STATE, EDITOR_STATE, SAFE_TOOLS, SCENE_PLANNED, serveSafeTool, userTurn } from "./lib/cut-eval/fixtures";
import { queueCases, type QueueCase } from "./lib/cut-eval/queueCases";

const args = process.argv.slice(2);
const argValue = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const BASE = argValue("--base") ?? "http://localhost:3000";
const ONLY = argValue("--only")?.split(",").map((s) => s.trim());
const RUNS = Number(argValue("--runs") ?? 1);
const LIVE = !args.includes("--no-live");
const GATE = (() => {
  const v = argValue("--gate-model");
  if (!v) return geminiModelRoleNames.fastDecision;
  return (geminiModels as Record<string, string>)[v] ?? v;
})();

/** The eval's deps: the dev server as the inference proxy. The triage uses
 * the post function and the gate model alone. */
const deps: CutAgentDeps = {
  post: (payload, signal) =>
    fetch(`${BASE}/api/inference/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-donkey-client-id": "donkey-cut-eval",
        "x-donkey-dev-auth-bypass": "1",
      },
      body: JSON.stringify(payload),
      signal,
    }),
  execTool: async () => ({}),
  models: { simple: GATE, complex: GATE, gate: GATE },
  buildContext: () => ({}),
  resolveRefs: async () => [],
};

interface RunResult {
  ms: number;
  wrong: { text: string; expected: QueueVerdict; got: QueueVerdict }[];
}

async function runCase(c: QueueCase): Promise<RunResult> {
  const t0 = performance.now();
  const rows = c.rows.map((r, i) => ({ id: `r${i}`, text: r.text }));
  const verdicts = await triageQueuedMessages({
    anchor: c.anchor,
    waiting: (c.waiting ?? []).map((text, i) => ({ id: `w${i}`, text })),
    rows,
    deps,
  });
  const wrong: RunResult["wrong"] = [];
  c.rows.forEach((r, i) => {
    const got = verdicts.get(`r${i}`) ?? "queue";
    if (got !== r.expect) wrong.push({ text: r.text, expected: r.expect, got });
  });
  return { ms: performance.now() - t0, wrong };
}

/** A real turn with a fold landing mid-way: "add a title" goes out, and the
 * moment its first tool call is served, "make it blue" folds in — the way the
 * page steers a triaged row into the live turn. The fold must resolve as
 * taken, sit in the thread's context as a user message, and show in the
 * turn's work: a second overlay edit or a reply that covers the color. */
async function runLiveFold(): Promise<string[]> {
  const notes: string[] = [];
  const threadId = `eval-queue-fold-${Date.now()}`;
  const trace: { name: string; args: Record<string, unknown> }[] = [];
  let folded: Promise<boolean> | null = null;
  const live: CutAgentDeps = {
    ...deps,
    models: {
      simple: geminiModelRoleNames.chatSimple,
      complex: geminiModelRoleNames.chat,
      gate: geminiModelRoleNames.fastDecision,
    },
    buildContext: () => EDITOR_STATE,
    execTool: async (name, args) => {
      trace.push({ name, args });
      if (name === "add_title") {
        folded ??= foldIntoCutChat({ threadId, text: "make it blue", attachments: [], deps: live });
        return { ok: true, id: "t-new", start: 0, len: 3 };
      }
      if (name === "update_overlay" || name === "update_title") return { ok: true };
      if (SAFE_TOOLS.has(name)) return serveSafeTool(name, EDITOR_STATE);
      return { error: "eval: this tool is disabled for this turn — do not retry it" };
    },
  };
  const messages = [userTurn("Add a title that says Welcome at the start")] as unknown as UIMessage[];
  let reply = "";
  const stream = streamCutChat({ threadId, model: geminiModelRoleNames.chat, messages, deps: live });
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as unknown as { type: string; delta?: string; errorText?: string };
    if (chunk.type === "text-delta" && chunk.delta) reply += chunk.delta;
    if (chunk.type === "error" && chunk.errorText) notes.push(`turn error: ${chunk.errorText}`);
  }
  if (!folded) notes.push("add_title never ran, so nothing folded");
  else if (!(await folded)) notes.push("the fold was handed back: the turn ended before taking it");
  const session = readPiSession(threadId) ?? [];
  const inContext = session.some(
    (m) =>
      (m as Message).role === "user" &&
      (m as { fold?: true }).fold === true &&
      JSON.stringify((m as Message).content).includes("make it blue")
  );
  if (!inContext) notes.push("the fold is missing from the thread's stored context");
  const styled = trace.some(
    (t, i) => i > 0 && (t.name === "update_overlay" || t.name === "update_title" || t.name === "add_title") && /blue|#[0-9a-f]{3,8}/i.test(JSON.stringify(t.args))
  );
  if (!styled && !/blue/i.test(reply)) notes.push("the turn never acted on the fold (no blue edit, no mention)");
  dropPiSession(threadId);
  console.log(
    `  ${notes.length === 0 ? "ok  " : "FAIL"} live-fold-lands-in-running-turn  tools: ${trace.map((t) => t.name).join(" → ")}`
  );
  for (const n of notes) console.log(`       - ${n}`);
  if (notes.length > 0) console.log(`       reply: ${reply.trim().slice(0, 200)}`);
  return notes;
}

/** A fold the turn cannot do yet by construction: a scene plan goes out and
 * stops at the storyboard for the user's approval, and "once it's rendered,
 * put soft music under it" folds in on the plan call. The shots cannot
 * render this turn, so the turn must hand the music ask to the queue in the
 * user's words and make no music now. */
async function runLiveQueueBack(): Promise<string[]> {
  const notes: string[] = [];
  const threadId = `eval-queue-back-${Date.now()}`;
  const trace: { name: string; args: Record<string, unknown> }[] = [];
  let folded: Promise<boolean> | null = null;
  const live: CutAgentDeps = {
    ...deps,
    models: {
      simple: geminiModelRoleNames.chatSimple,
      complex: geminiModelRoleNames.chat,
      gate: geminiModelRoleNames.fastDecision,
    },
    buildContext: () => AUDIO_STATE,
    execTool: async (name, args) => {
      trace.push({ name, args });
      if (name === "generate_scene") {
        folded ??= foldIntoCutChat({
          threadId,
          text: "once it's rendered, put some soft music under it",
          attachments: [],
          deps: live,
        });
        return SCENE_PLANNED;
      }
      if (name === "queue_message") return { queued: true, note: "It runs as its own turn after this one finishes." };
      if (SAFE_TOOLS.has(name)) return serveSafeTool(name, AUDIO_STATE);
      return { error: "eval: this tool is disabled for this turn — do not retry it" };
    },
  };
  const messages = [
    userTurn("turn my narration audio into a smooth 2D cartoon", { state: AUDIO_STATE }),
  ] as unknown as UIMessage[];
  let reply = "";
  const stream = streamCutChat({ threadId, model: geminiModelRoleNames.chat, messages, deps: live });
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as unknown as { type: string; delta?: string; errorText?: string };
    if (chunk.type === "text-delta" && chunk.delta) reply += chunk.delta;
    if (chunk.type === "error" && chunk.errorText) notes.push(`turn error: ${chunk.errorText}`);
  }
  if (!folded) notes.push("add_title never ran, so nothing folded");
  else if (!(await folded)) notes.push("the fold was handed back: the turn ended before taking it");
  if (!trace.some((t) => t.name === "generate_scene")) notes.push("generate_scene never ran, so nothing folded");
  const queued = trace.find((t) => t.name === "queue_message");
  if (!queued) notes.push("the turn never called queue_message for the music");
  else if (!/music/i.test(String(queued.args.text ?? ""))) notes.push(`queue_message text lost the ask: ${JSON.stringify(queued.args)}`);
  if (trace.some((t) => /music|approve_scene|add_clip|stock/.test(t.name))) notes.push("the turn acted on the music, or approved the plan, in the same turn");
  dropPiSession(threadId);
  console.log(
    `  ${notes.length === 0 ? "ok  " : "FAIL"} live-fold-queues-what-needs-the-result  tools: ${trace.map((t) => t.name).join(" → ")}`
  );
  for (const n of notes) console.log(`       - ${n}`);
  if (notes.length > 0) console.log(`       reply: ${reply.trim().slice(0, 200)}`);
  return notes;
}

async function main() {
  const selected = queueCases.filter((c) => !ONLY || ONLY.includes(c.name));
  if (selected.length === 0 && !LIVE) throw new Error(`No case named "${ONLY?.join(", ")}".`);
  console.log(`== queue triage  gate=${resolveGeminiModel(GATE)}  runs=${RUNS}`);
  let failed = 0;
  const times: number[] = [];
  for (const c of selected) {
    const runs: RunResult[] = [];
    for (let i = 0; i < RUNS; i++) runs.push(await runCase(c));
    const passes = runs.filter((r) => r.wrong.length === 0).length;
    const p50 = [...runs.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(runs.length / 2)];
    times.push(p50);
    const mark = passes === runs.length ? "ok  " : passes > 0 ? "part" : "FAIL";
    if (passes === 0) failed++;
    console.log(`  ${mark} ${c.name}  pass ${passes}/${runs.length}  p50 ${Math.round(p50)}ms`);
    for (const r of runs) {
      for (const w of r.wrong)
        console.log(`       - "${w.text}" → ${w.got}, expected ${w.expected}`);
    }
  }
  const sorted = [...times].sort((a, b) => a - b);
  if (sorted.length > 0)
    console.log(
      `\n${selected.length - failed}/${selected.length} cases pass; triage p50 ${Math.round(sorted[Math.floor(sorted.length / 2)])}ms, max ${Math.round(sorted.at(-1) ?? 0)}ms`
    );
  if (LIVE) {
    console.log("\n== live fold");
    if (!ONLY || ONLY.includes("live-fold-lands-in-running-turn")) {
      if ((await runLiveFold()).length > 0) failed++;
    }
    if (!ONLY || ONLY.includes("live-fold-queues-what-needs-the-result")) {
      if ((await runLiveQueueBack()).length > 0) failed++;
    }
  }
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
