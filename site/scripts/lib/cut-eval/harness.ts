/**
 * The eval runner: one case = one chat turn through the PRODUCTION loop —
 * streamCutChat, the pi-based turn runner the editor itself uses — with the
 * eval's own deps injected: the dev server as the inference proxy, sims and
 * stubs as the tool server, and fixture snapshots as the editor state.
 *
 * Every run is timed off the loop's own hooks: the gate, each LLM round and
 * its first visible delta, and each tool serve. Retries happen inside the
 * transport and are invisible here, so latency numbers are the turn as the
 * user experiences it.
 */

import type { UIMessage } from "ai";
import { AI_SKILLS } from "../../../src/cut/server/ai/catalog";
import { geminiModelRoles } from "../../../src/lib/inference/gemini-models";
import { streamCutChat, dropPiSession, type CutAgentDeps } from "../../../src/cut/lib/pi/cutAgent";
import type { TurnIntent } from "../../../src/cut/lib/turnIntent";
import { EDITOR_STATE, SAFE_TOOLS, serveSafeTool } from "./fixtures";
import { judgeReply, replyShapeNotes } from "./graders";
import type { EvalCase } from "./cases";

export interface RunConfig {
  /** Dev server base URL. */
  base: string;
  /** Model a simple-verdict turn's rounds run on. */
  simpleModel: string;
  /** Model a complex-verdict (or fail-open) turn's rounds run on. */
  complexModel: string;
  /** Model the gate/router call runs on. */
  gateModel: string;
  /** Model the voice/taste judge runs on; null skips the judge. */
  judgeModel: string | null;
}

/** Production's config: the three-way gate routes between the two chat roles. */
export const defaultRunConfig = (base: string): RunConfig => ({
  base,
  simpleModel: geminiModelRoles.chatSimple,
  complexModel: geminiModelRoles.chat,
  gateModel: geminiModelRoles.fastDecision,
  judgeModel: geminiModelRoles.fastDecision,
});

export interface RoundTiming {
  /** Wall time of the round's request, request start → message settled. */
  roundMs: number;
  /** Round start → first visible (non-whitespace) text delta, if any text streamed. */
  firstDeltaMs: number | null;
  calls: { name: string; execMs: number }[];
}

export interface RunTimings {
  /** Wall time of the gate's classify call. */
  gateMs: number;
  /** True when attachments classified the turn "work" with no model call. */
  gateSkipped: boolean;
  /** Turn start → first visible text delta anywhere in the turn. */
  ttftMs: number | null;
  /** Σ round wall times. */
  modelMs: number;
  /** Σ tool-serve wall times (stubs and sims today, so ≈0 — kept separate so
   * real tool execution never pollutes model timing). */
  toolMs: number;
  /** gateMs + modelMs + toolMs — the turn's critical path.
   * The judge call is grading overhead, so judgeMs stays out of it. */
  totalMs: number;
  judgeMs?: number;
  /** Transport retries happen inside the loop's stream layer now; these stay
   * for the report schema and read 0. */
  retryMs: number;
  retries: number;
  rounds: RoundTiming[];
}

export interface TraceEntry {
  name: string;
  /** Zero-based round the call arrived in. */
  round: number;
  /** Turn start → this call being served. */
  atMs: number;
  execMs: number;
}

export interface CaseResult {
  pass: boolean;
  reply: string;
  trace: TraceEntry[];
  violations: string[];
  notes: string[];
  /** The judge's complaint (or transport note). Report-only: never flips pass. */
  judgeNote: string | null;
  intent: TurnIntent;
  /** The model the rounds ran on — differs per turn under a router config. */
  roundModel: string;
  timings: RunTimings;
}

let runSeq = 0;

export async function runCase(c: EvalCase, cfg: RunConfig): Promise<CaseResult> {
  const turnStart = performance.now();
  const messages = c.input();
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const askText = lastUser?.parts.find((p) => p.type === "text")?.text ?? "";
  const sim = c.simulate?.();

  const trace: TraceEntry[] = [];
  const rounds: RoundTiming[] = [];
  const violations: string[] = [];
  const notes: string[] = [];
  let intent: TurnIntent = "complex";
  let gateMs = 0;
  let gateSkipped = false;
  let modelMs = 0;
  let toolMs = 0;
  let ttftMs: number | null = null;
  let reply = "";
  let streamError: string | null = null;
  let extensions = 0;

  const deps: CutAgentDeps = {
    post: (payload, signal) =>
      fetch(`${cfg.base}/api/inference/responses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-donkey-client-id": "donkey-cut-eval",
          "x-donkey-dev-auth-bypass": "1",
        },
        body: JSON.stringify(payload),
        signal,
      }),
    execTool: async (name, args) => {
      const atMs = performance.now() - turnStart;
      const e0 = performance.now();
      const record = (execMs: number) => {
        toolMs += execMs;
        const round = Math.max(0, rounds.length - 1);
        trace.push({ name, round, atMs, execMs });
        rounds[round]?.calls.push({ name, execMs });
      };
      try {
        const simulated = sim?.(name, args);
        if (name === "read_skill") {
          const doc = AI_SKILLS[String(args.name ?? "")];
          return doc ? { doc } : { error: "No such skill." };
        }
        if (simulated !== undefined) return simulated;
        if (c.stubs && name in c.stubs) {
          const stub = c.stubs[name];
          // A stub can script the tool FAILING, the way runAiTool throws.
          if (stub && typeof stub === "object" && "__error" in stub)
            throw new Error(String((stub as { __error: unknown }).__error));
          return stub;
        }
        if (SAFE_TOOLS.has(name)) return serveSafeTool(name, c.state ?? EDITOR_STATE);
        violations.push(name);
        return { error: "eval: this tool is disabled for this turn — do not retry it" };
      } finally {
        record(performance.now() - e0);
      }
    },
    models: { simple: cfg.simpleModel, complex: cfg.complexModel, gate: cfg.gateModel },
    buildContext: () => lastUser?.__state ?? c.state ?? EDITOR_STATE,
    resolveRefs: async () => lastUser?.__wireParts ?? [],
    debris: () => c.debris ?? [],
    limits: c.limits,
    hooks: {
      onGate: (i, ms, skipped) => {
        intent = i;
        gateMs = ms;
        gateSkipped = skipped;
      },
      onRound: (ms, firstDeltaMs) => {
        modelMs += ms;
        rounds.push({ roundMs: ms, firstDeltaMs, calls: [] });
      },
      onExtension: (n) => {
        extensions = n;
      },
    },
  };

  // Each run is its own thread so pi sessions never leak between runs.
  const threadId = `eval-${c.name}-${++runSeq}`;
  const stream = streamCutChat({
    threadId,
    model: cfg.complexModel,
    messages: messages as unknown as UIMessage[],
    deps,
  });
  try {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value as unknown as { type: string; delta?: string; errorText?: string };
      if (chunk.type === "text-delta" && chunk.delta) {
        if (ttftMs === null && chunk.delta.trim()) ttftMs = performance.now() - turnStart;
        reply += chunk.delta;
      } else if (chunk.type === "text-start" && reply) {
        reply += "\n";
      } else if (chunk.type === "error" && chunk.errorText) {
        streamError = chunk.errorText;
      }
    }
  } finally {
    dropPiSession(threadId);
  }
  reply = reply.trim();
  if (streamError) throw new Error(streamError);

  // Rounds are timed off assistant messages; a round that requested tools has
  // its calls attached above. Cases assert the gate side of the verdict;
  // simple-vs-complex is routing, scored by latency, so either satisfies a
  // "work" expectation.
  const gateSide = intent === "chat" ? "chat" : "work";
  if (c.gate && gateSide !== c.gate) notes.push(`gate said ${intent}, expected ${c.gate}`);
  if (!c.reply.test(reply)) notes.push(`reply did not match ${c.reply}`);
  for (const t of c.requiredTools ?? []) {
    if (!trace.some((e) => e.name === t)) notes.push(`required tool ${t} was never called`);
  }
  if (c.anyTools && !c.anyTools.some((t) => trace.some((e) => e.name === t)))
    notes.push(`none of [${c.anyTools.join(", ")}] were called`);
  if (c.maxToolCalls !== undefined && trace.length > c.maxToolCalls)
    notes.push(`slow: ${trace.length} tool calls (cap ${c.maxToolCalls})`);
  if (violations.length > 0) notes.push(`mutating tools called: ${violations.join(", ")}`);
  if (c.extensions?.min !== undefined && extensions < c.extensions.min)
    notes.push(`auto-continue extended ${extensions}× (needed ≥${c.extensions.min})`);
  if (c.extensions?.max !== undefined && extensions > c.extensions.max)
    notes.push(`auto-continue extended ${extensions}× (cap ${c.extensions.max})`);
  const simVerify = (sim as unknown as { verify?: () => string[] } | undefined)?.verify;
  if (simVerify) notes.push(...simVerify());

  const mutated = trace.some(
    (e) =>
      !SAFE_TOOLS.has(e.name) &&
      e.name !== "read_skill" &&
      e.name !== "list_skills" &&
      !violations.includes(e.name)
  );
  notes.push(...replyShapeNotes(reply, { mutated, expectsQuestion: c.expectsQuestion }));

  let judgeNote: string | null = null;
  let judgeMs: number | undefined;
  if (cfg.judgeModel && reply) {
    const verdict = await judgeReply({
      base: cfg.base,
      model: cfg.judgeModel,
      userAsk: askText,
      reply,
      didWork: mutated,
    });
    judgeNote = verdict.note;
    judgeMs = verdict.judgeMs;
  }

  const timings: RunTimings = {
    gateMs,
    gateSkipped,
    ttftMs,
    modelMs,
    toolMs,
    totalMs: gateMs + modelMs + toolMs,
    judgeMs,
    retryMs: 0,
    retries: 0,
    rounds,
  };
  return {
    pass: notes.length === 0,
    reply,
    trace,
    violations,
    notes,
    judgeNote,
    intent,
    roundModel: intent === "simple" ? cfg.simpleModel : cfg.complexModel,
    timings,
  };
}
