/**
 * The eval runner: one case = one chat turn replayed against the live model
 * through the hosted Responses route, with the production loop's shape — the
 * tool gate first, then streamed tool rounds until the model settles.
 *
 * Every run is timed. Rounds stream (stream:true, as production does), so the
 * harness can stamp time-to-first-token; the gate, each round, and each tool
 * serve get their own wall-clock. Retry attempts and backoff sleeps accumulate
 * separately in retryMs so transient upstream hiccups never pollute the
 * latency numbers.
 */

import {
  AI_SKILLS,
  AI_TOOLS,
  systemPrompt,
} from "../../../src/cut/server/ai/catalog";
import {
  parseTurnIntent,
  TURN_INTENT_PROMPT,
  turnIntentInput,
  type TurnIntent,
} from "../../../src/cut/lib/turnIntent";
import { geminiModelRoles } from "../../../src/lib/inference/gemini-models";
import { EDITOR_STATE, SAFE_TOOLS, serveSafeTool, type Item } from "./fixtures";
import type { EvalCase } from "./cases";

// Matches the production chat loop's tool-round cap (geminiChat.ts).
export const MAX_ROUNDS = 24;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const TRANSIENT_RETRIES = 2;

export interface RunConfig {
  /** Dev server base URL. */
  base: string;
  /** Model the chat rounds run on. */
  chatModel: string;
  /** Model the tool gate runs on. */
  gateModel: string;
}

export const defaultRunConfig = (base: string): RunConfig => ({
  base,
  chatModel: geminiModelRoles.chat,
  gateModel: geminiModelRoles.fastDecision,
});

export interface RoundTiming {
  /** Wall time of the round's successful request, request start → body settled. */
  roundMs: number;
  /** Round start → first visible (non-whitespace) text delta, if any text streamed. */
  firstDeltaMs: number | null;
  calls: { name: string; execMs: number }[];
}

export interface RunTimings {
  /** Wall time of the gate's successful classify call. */
  gateMs: number;
  /** True when attachments classified the turn "work" with no model call. */
  gateSkipped: boolean;
  /** Turn start → first visible text delta anywhere in the turn. */
  ttftMs: number | null;
  /** Σ successful round wall times. */
  modelMs: number;
  /** Σ tool-serve wall times (stubs and sims today, so ≈0 — kept separate so
   * real tool execution never pollutes model timing). */
  toolMs: number;
  /** gateMs + modelMs + toolMs — the turn's critical path, retries excluded. */
  totalMs: number;
  /** Failed attempts plus backoff sleeps, across the gate and every round. */
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
  intent: TurnIntent;
  timings: RunTimings;
}

interface RetryTally {
  retryMs: number;
  retries: number;
}

interface ResponseBody {
  output_text?: string;
  output?: {
    type?: string;
    id?: string;
    name?: string;
    arguments?: unknown;
    thoughtSignature?: string;
  }[];
}

const toolDeclarations = AI_TOOLS.map((t) => ({
  type: "function",
  name: t.name,
  description: t.description,
  parameters: t.inputSchema,
}));

const post = (cfg: RunConfig, body: Record<string, unknown>) =>
  fetch(`${cfg.base}/api/inference/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-donkey-client-id": "donkey-cut-eval",
      "x-donkey-dev-auth-bypass": "1",
    },
    body: JSON.stringify(body),
  });

const sleepTallied = async (ms: number, tally: RetryTally) => {
  const t0 = performance.now();
  await new Promise((r) => setTimeout(r, ms));
  tally.retryMs += performance.now() - t0;
};

/** A case item's composer text with the envelope stripped back off — the
 * gate's classifier sees the raw turn, before the snapshot rides on. */
const itemText = (item: Item): string => {
  const first = (item.content as { text?: string }[] | undefined)?.find(
    (p) => typeof p.text === "string"
  );
  return (first?.text ?? "")
    .split("\n\n<attached_assets>")[0]
    .split("\n\n<editor_state>")[0]
    .trim();
};

/** The production tool gate, replicated from geminiChat.ts: a message with
 * attachments is work by construction; otherwise the fast-decision model
 * judges the newest message. Fails open to "work". */
export async function classifyIntent(
  input: Item[],
  cfg: RunConfig,
  tally: RetryTally
): Promise<{ intent: TurnIntent; gateMs: number; gateSkipped: boolean }> {
  const lastUser = [...input].reverse().find((i) => i.role === "user");
  const raw =
    ((lastUser?.content as { text?: string }[]) ?? []).find((p) => typeof p.text === "string")
      ?.text ?? "";
  if (raw.includes("<attached_assets>")) return { intent: "work", gateMs: 0, gateSkipped: true };
  const turns = input.map((i) => ({
    role: (i.role === "user" ? "user" : "assistant") as "user" | "assistant",
    text: itemText(i),
  }));
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    const res = await post(cfg, {
      donkeyProvider: "gemini",
      model: cfg.gateModel,
      instructions: TURN_INTENT_PROMPT,
      input: turnIntentInput(turns),
    });
    if (res.ok) {
      const body = (await res.json()) as { output_text?: string };
      return {
        intent: parseTurnIntent(body.output_text),
        gateMs: performance.now() - t0,
        gateSkipped: false,
      };
    }
    tally.retries++;
    tally.retryMs += performance.now() - t0;
    if (!RETRYABLE_STATUS.has(res.status) || attempt >= TRANSIENT_RETRIES)
      return { intent: "work", gateMs: 0, gateSkipped: false };
    await sleepTallied(800 * (attempt + 1), tally);
  }
}

/** The route's SSE frames (mirrors geminiChat.ts): every text delta goes out
 * through onDelta, and the terminal `response.completed` frame — the same body
 * a plain round returns — is the return value. */
async function readStreamedRound(
  res: Response,
  onDelta: (delta: string) => void
): Promise<ResponseBody> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Gemini returned no response stream.");
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: ResponseBody | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const split = buffer.indexOf("\n\n");
      if (split === -1) break;
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      let isError = false;
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) isError = line.slice(7).trim() === "error";
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (!data || data === "[DONE]") continue;
      let event: { type?: string; delta?: string; response?: ResponseBody; message?: string };
      try {
        event = JSON.parse(data) as typeof event;
      } catch {
        continue;
      }
      if (isError) throw new Error(event.message || "Gemini stream failed.");
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        onDelta(event.delta);
      } else if (event.type === "response.completed" && event.response) {
        completed = event.response;
      }
    }
  }
  if (!completed) throw new Error("Gemini stream ended early.");
  return completed;
}

/** One streamed round with transient retries. A broken stream retries only
 * while no delta has arrived (production's rule); failed attempts and backoff
 * land in the tally, so roundMs is the successful request alone. */
async function postRoundTimed(
  cfg: RunConfig,
  payload: Record<string, unknown>,
  tally: RetryTally,
  onFirstDelta: () => void
): Promise<{ body: ResponseBody; roundMs: number; firstDeltaMs: number | null }> {
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    let res: Response;
    try {
      res = await post(cfg, { ...payload, stream: true });
    } catch (err) {
      tally.retries++;
      tally.retryMs += performance.now() - t0;
      if (attempt >= TRANSIENT_RETRIES) throw err;
      await sleepTallied(800 * (attempt + 1), tally);
      continue;
    }
    if (res.ok) {
      let firstDeltaMs: number | null = null;
      let delivered = false;
      try {
        const body = await readStreamedRound(res, (delta) => {
          delivered = true;
          if (firstDeltaMs === null && delta.trim()) {
            firstDeltaMs = performance.now() - t0;
            onFirstDelta();
          }
        });
        return { body, roundMs: performance.now() - t0, firstDeltaMs };
      } catch (err) {
        tally.retries++;
        tally.retryMs += performance.now() - t0;
        if (delivered || attempt >= TRANSIENT_RETRIES) throw err;
        await sleepTallied(800 * (attempt + 1), tally);
        continue;
      }
    }
    const failMs = performance.now() - t0;
    if (!RETRYABLE_STATUS.has(res.status) || attempt >= TRANSIENT_RETRIES)
      throw new Error(`responses ${res.status}: ${(await res.text()).slice(0, 300)}`);
    tally.retries++;
    tally.retryMs += failMs;
    await sleepTallied(800 * (attempt + 1), tally);
  }
}

export async function runCase(c: EvalCase, cfg: RunConfig): Promise<CaseResult> {
  const turnStart = performance.now();
  const tally: RetryTally = { retryMs: 0, retries: 0 };
  const input = c.input();
  // The gate runs first, exactly as in production: a "chat" verdict strips
  // the tool declarations from the whole turn. (Production overlaps the gate
  // with input assembly, which is negligible — serial gate + round 1 is the
  // same critical path the user perceives.)
  const gate = await classifyIntent(input, cfg, tally);
  const tools = gate.intent === "work" ? toolDeclarations : undefined;
  const sim = c.simulate?.();
  const trace: TraceEntry[] = [];
  const rounds: RoundTiming[] = [];
  const violations: string[] = [];
  const notes: string[] = [];
  let reply = "";
  let emptyRounds = 0;
  let ttftMs: number | null = null;
  let modelMs = 0;
  let toolMs = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { body, roundMs, firstDeltaMs } = await postRoundTimed(
      cfg,
      {
        donkeyProvider: "gemini",
        model: cfg.chatModel,
        instructions: systemPrompt(),
        input,
        ...(tools ? { tools } : {}),
      },
      tally,
      () => {
        if (ttftMs === null) ttftMs = performance.now() - turnStart;
      }
    );
    modelMs += roundMs;
    const roundTiming: RoundTiming = { roundMs, firstDeltaMs, calls: [] };
    rounds.push(roundTiming);

    const text = (body.output_text ?? "").trim();
    if (text) reply = reply ? `${reply}\n${text}` : text;

    const calls = (body.output ?? []).filter((o) => o.type === "function_call");
    if (calls.length === 0) {
      // A no-call round with nothing said all turn is the degenerate empty
      // STOP; the production loop (geminiChat.ts) re-asks the same input a
      // couple of times, so the eval does too rather than scoring it silent.
      if (!reply && emptyRounds < 2) {
        emptyRounds++;
        continue;
      }
      break;
    }
    emptyRounds = 0;

    const assistantParts: Item[] = text ? [{ text }] : [];
    const responseParts: Item[] = [];
    for (const call of calls) {
      const name = String(call.name ?? "unknown");
      const id = call.id ? String(call.id) : `call-${trace.length + 1}`;
      const part: Item = {
        functionCall: {
          id,
          name,
          args: call.arguments && typeof call.arguments === "object" ? call.arguments : {},
        },
      };
      if (call.thoughtSignature) part.thoughtSignature = call.thoughtSignature;
      assistantParts.push(part);

      let response: unknown;
      const argsObj =
        call.arguments && typeof call.arguments === "object"
          ? (call.arguments as Record<string, unknown>)
          : {};
      const atMs = performance.now() - turnStart;
      const e0 = performance.now();
      const simulated = sim?.(name, argsObj);
      if (name === "read_skill") {
        const doc = AI_SKILLS[String(argsObj.name ?? "")];
        response = doc ? { doc } : { error: "No such skill." };
      } else if (simulated !== undefined) {
        response = simulated;
      } else if (c.stubs && name in c.stubs) {
        response = c.stubs[name];
      } else if (SAFE_TOOLS.has(name)) {
        response = serveSafeTool(name, c.state ?? EDITOR_STATE);
      } else {
        violations.push(name);
        response = { error: "eval: this tool is disabled for this turn" };
      }
      const execMs = performance.now() - e0;
      toolMs += execMs;
      trace.push({ name, round, atMs, execMs });
      roundTiming.calls.push({ name, execMs });
      responseParts.push({
        type: "function_response",
        id,
        name,
        response:
          response && typeof response === "object" && !Array.isArray(response)
            ? response
            : { result: response ?? null },
      });
    }
    input.push({ role: "assistant", content: assistantParts });
    input.push({ role: "user", content: responseParts });
  }

  if (c.gate && gate.intent !== c.gate) notes.push(`gate said ${gate.intent}, expected ${c.gate}`);
  if (!c.reply.test(reply)) notes.push(`reply did not match ${c.reply}`);
  for (const t of c.requiredTools ?? []) {
    if (!trace.some((e) => e.name === t)) notes.push(`required tool ${t} was never called`);
  }
  if (c.anyTools && !c.anyTools.some((t) => trace.some((e) => e.name === t)))
    notes.push(`none of [${c.anyTools.join(", ")}] were called`);
  if (c.maxToolCalls !== undefined && trace.length > c.maxToolCalls)
    notes.push(`slow: ${trace.length} tool calls (cap ${c.maxToolCalls})`);
  if (violations.length > 0) notes.push(`mutating tools called: ${violations.join(", ")}`);

  const timings: RunTimings = {
    gateMs: gate.gateMs,
    gateSkipped: gate.gateSkipped,
    ttftMs,
    modelMs,
    toolMs,
    totalMs: gate.gateMs + modelMs + toolMs,
    retryMs: tally.retryMs,
    retries: tally.retries,
    rounds,
  };
  return {
    pass: notes.length === 0,
    reply,
    trace,
    violations,
    notes,
    intent: gate.intent,
    timings,
  };
}
