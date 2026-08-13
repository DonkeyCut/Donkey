import type { UIMessage, UIMessageChunk } from "ai";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, UserMessage } from "@earendil-works/pi-ai";
import { AI_TOOLS, attachedAssetsBlock, systemPrompt } from "@/cut/server/ai/catalog";
import { parseTurnIntent, turnIntentInput, turnIntentPrompt, type TurnIntent } from "../turnIntent";
import { enforceContextBudget } from "./contextBudget";
import { donkeyModel } from "./donkeyModel";
import { ledgerText, recordCall, type LedgerRecord } from "./mutationLedger";
import { makeDonkeyStream, type DonkeyToolDetails, type PostFn, type WireCarrier, type WirePart } from "./donkeyStream";
import { toAgentTools, type ExecTool } from "./tools";
import { subscribeUiChunks } from "./uiChunks";

// The chat turn runner on the pi agent harness. Each turn: the intent gate
// classifies the newest message (chat verdicts withhold every tool, simple
// verdicts downgrade the model and narrow the tool catalog to the areas the
// verdict names), the Agent loops model calls and tool
// executions against the live editor store, and the events stream out as the
// UIMessageChunks AiPanel already consumes. The thread's LLM context is pi's
// own message list, kept per thread in the session registry — past tool calls
// replay as structured toolCall/toolResult messages, so no bookkeeping rides
// as prose the model could mimic.

// A round is one assistant message that requests tools. The budget
// auto-extends so the user never types "keep going". At the ceiling every
// call blocks with a reply-now instruction; a model that still requests
// tools the round after gets its batch terminated, ending the turn.
const ROUND_BUDGET = 24;
const MAX_EXTENSIONS = 3;

export interface CutAgentDeps {
  post: PostFn;
  execTool: ExecTool;
  models: { simple: string; complex: string; gate: string };
  /** The fresh editor snapshot for the newest message. */
  buildContext: () => unknown;
  /** Attachment metadata resolved into wire media parts for the newest
   * message. Best-effort — a ref that no longer resolves returns []. */
  resolveRefs: (meta: unknown[]) => Promise<WirePart[]>;
  /** Debris the project currently holds (parked transition bars, items
   * stranded past the end of the video), one human-readable line each. Read
   * fresh for each ledger build. */
  debris?: () => string[];
  onAuthFail?: () => void;
  noCreditsMessage?: string;
  /** Round-budget overrides (the eval exercises auto-continue with a tiny
   * budget; production runs the defaults). */
  limits?: { roundBudget?: number; maxExtensions?: number };
  /** Timing instrumentation: the eval asserts on it, production logs it at
   * debug level. */
  hooks?: {
    onGate?: (intent: TurnIntent, ms: number, skipped: boolean) => void;
    /** One LLM round settled: wall time, and time to its first visible delta. */
    onRound?: (ms: number, firstDeltaMs: number | null) => void;
    /** The round budget auto-extended (n = extensions so far). */
    onExtension?: (n: number) => void;
  };
}

// ---------------------------------------------------------------------------
// Session registry: each thread's pi context, hydrated from the stored thread
// and read back by the save path. Live for the page's lifetime.

const sessions = new Map<string, AgentMessage[]>();

/** The budget-extension steer is turn-local scaffolding; this prefix marks it
 * so the save path can keep it out of the stored session. */
const BUDGET_STEER_PREFIX = "[budget]";

function isBudgetSteer(m: AgentMessage): boolean {
  const msg = m as Message;
  return (
    msg.role === "user" &&
    typeof msg.content === "string" &&
    msg.content.startsWith(BUDGET_STEER_PREFIX)
  );
}

/** Every toolCall in the session answered. An aborted batch leaves calls with
 * no toolResult, and Gemini rejects a replay whose functionCalls outnumber
 * their responses — so unanswered calls get a synthetic interrupted result,
 * inserted right after the assistant message that made them. */
function settleDanglingToolCalls(messages: AgentMessage[]): AgentMessage[] {
  const answered = new Set<string>();
  for (const m of messages) {
    const msg = m as Message;
    if (msg.role === "toolResult") answered.add(msg.toolCallId);
  }
  let changed = false;
  const out: AgentMessage[] = [];
  for (const m of messages) {
    out.push(m);
    const msg = m as Message;
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const c of msg.content) {
      if (c.type !== "toolCall" || answered.has(c.id)) continue;
      changed = true;
      out.push({
        role: "toolResult",
        toolCallId: c.id,
        toolName: c.name,
        content: [{ type: "text", text: "Interrupted — this call never ran." }],
        isError: true,
        timestamp: msg.timestamp ?? 0,
      } as AgentMessage);
    }
  }
  return changed ? out : messages;
}

/** The legacy loop's media invariant, kept on the pi session: attachment
 * payloads and tool media ride only the turn that produced them, and older
 * turns keep their metadata text alone. Runs before every model call and at
 * save, so a thread with heavy attachments pays for them once per turn — the
 * wire and the stored session both shed the previous turns' bytes. */
function pruneStaleMedia(messages: AgentMessage[]): AgentMessage[] {
  let lastAsk = -1;
  messages.forEach((m, i) => {
    if ((m as Message).role === "user" && !isBudgetSteer(m)) lastAsk = i;
  });
  return messages.map((m, i) => {
    if (i >= lastAsk) return m;
    const msg = m as Message;
    if (msg.role === "user") {
      const u = msg as UserMessage & WireCarrier;
      const hasWire = (u.wireParts?.length ?? 0) > 0;
      const hasImages =
        Array.isArray(u.content) && u.content.some((c) => c.type === "image");
      if (!hasWire && !hasImages) return m;
      const content = Array.isArray(u.content)
        ? u.content.filter((c) => c.type !== "image")
        : u.content;
      return {
        ...u,
        wireParts: undefined,
        content:
          Array.isArray(content) && content.length === 0
            ? [{ type: "text" as const, text: "(media from an earlier turn)" }]
            : content,
      } as AgentMessage;
    }
    if (msg.role === "toolResult") {
      const details = msg.details as DonkeyToolDetails | undefined;
      if (!details?.mediaParts?.length) return m;
      return { ...msg, details: { ...details, mediaParts: undefined } };
    }
    return m;
  });
}

/** A session fit to store and replay: no ephemeral steer messages, no stale
 * editor snapshots or media, and every toolCall paired with a result. */
function sanitizeSession(messages: AgentMessage[]): AgentMessage[] {
  return settleDanglingToolCalls(
    pruneStaleMedia(pruneStaleSnapshots(messages.filter((m) => !isBudgetSteer(m)))),
  );
}

export function hydratePiSession(threadId: string, messages: AgentMessage[] | undefined): void {
  if (messages && !sessions.has(threadId)) sessions.set(threadId, sanitizeSession(messages));
}

export function readPiSession(threadId: string): AgentMessage[] | undefined {
  return sessions.get(threadId);
}

export function dropPiSession(threadId: string): void {
  sessions.delete(threadId);
}

// ---------------------------------------------------------------------------

/** The tools an assistant turn finished, read off its rendered parts — the
 * legacy-thread converter's source for what a past reply executed. */
function toolsRanIn(m: UIMessage): string[] {
  const parts = m.parts as unknown as { type: string; state?: string; toolName?: string }[];
  return parts.flatMap((p) => {
    const name =
      p.type === "dynamic-tool"
        ? p.toolName
        : p.type.startsWith("tool-")
          ? p.type.slice(5)
          : undefined;
    return name && p.state === "output-available" ? [name] : [];
  });
}

/** A thread from before the pi loop, rebuilt as plain context: text turns,
 * with each past reply's completed tools folded in as prose. Nothing
 * tag-shaped exists for the model to mimic. */
function legacySession(history: UIMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const m of history) {
    let text = m.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("")
      .trim();
    if (m.role === "user") {
      const meta = (m.metadata as { attachments?: unknown[] } | undefined)?.attachments;
      if (Array.isArray(meta) && meta.length > 0) text += attachedAssetsBlock(meta);
      if (text) out.push({ role: "user", content: text, timestamp: 0 });
      continue;
    }
    const ran = toolsRanIn(m);
    if (ran.length > 0) {
      const counts = new Map<string, number>();
      for (const n of ran) counts.set(n, (counts.get(n) ?? 0) + 1);
      const list = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(", ");
      text += `${text ? "\n\n" : ""}(This reply already ran: ${list}. That work is done.)`;
    }
    if (text)
      out.push({
        role: "assistant",
        content: [{ type: "text", text }],
        api: "donkey-responses",
        provider: "donkey",
        model: "",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
      });
  }
  return out;
}

const EDITOR_STATE_BLOCK = /\n*<editor_state>[^]*?(?:<\/editor_state>|$)/g;

/** Past turns carry the snapshots they were sent with; only the newest one is
 * current. Runs before every model call and again at save, so the stored
 * session holds at most one snapshot. */
function pruneStaleSnapshots(messages: AgentMessage[]): AgentMessage[] {
  let lastWithSnapshot = -1;
  messages.forEach((m, i) => {
    const msg = m as Message;
    if (msg.role !== "user") return;
    const text = typeof msg.content === "string" ? msg.content : msg.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    if (text.includes("<editor_state>")) lastWithSnapshot = i;
  });
  return messages.map((m, i) => {
    if (i === lastWithSnapshot) return m;
    const msg = m as Message;
    if (msg.role !== "user") return m;
    if (typeof msg.content === "string") {
      if (!msg.content.includes("<editor_state>")) return m;
      return { ...msg, content: msg.content.replace(EDITOR_STATE_BLOCK, "") };
    }
    if (!msg.content.some((c) => c.type === "text" && c.text.includes("<editor_state>"))) return m;
    return {
      ...msg,
      content: msg.content.map((c) =>
        c.type === "text" && c.text.includes("<editor_state>")
          ? { ...c, text: c.text.replace(EDITOR_STATE_BLOCK, "") }
          : c
      ),
    };
  });
}

/** The thread's LLM context for this turn. A stored session can trail the
 * transcript — a page closed mid-turn saves the thread while the session
 * still ends at the previous settled turn — so any exchanges the session
 * missed are folded in as prose the way a legacy thread is. */
function sessionFor(threadId: string, history: UIMessage[]): AgentMessage[] {
  const stored = sessions.get(threadId);
  if (!stored) return legacySession(history);
  // One stored user message per real ask (ledger and steer messages never
  // persist), counted the way legacySession counts them.
  const covered = stored.filter((m) => (m as Message).role === "user").length;
  const asks = history.filter(
    (m) =>
      m.role === "user" &&
      (m.parts.some((p) => p.type === "text" && p.text.trim()) ||
        ((m.metadata as { attachments?: unknown[] } | undefined)?.attachments?.length ?? 0) > 0)
  );
  if (asks.length <= covered) return stored;
  const firstMissing = history.indexOf(asks[covered]);
  return [...stored, ...legacySession(history.slice(firstMissing))];
}

const GATE_PROMPT = turnIntentPrompt();

/** The turn's gate and router (ported from the legacy loop): judge the newest
 * message; "chat" withholds every tool, "simple" downgrades the model. A
 * message with attachments is complex by construction. Fails open. */
async function classifyTurnIntent(
  messages: UIMessage[],
  deps: CutAgentDeps,
  abortSignal?: AbortSignal
): Promise<{ intent: TurnIntent; skipped: boolean }> {
  const lastUser = messages.findLast((m) => m.role === "user");
  const attached = (lastUser?.metadata as { attachments?: unknown[] } | undefined)?.attachments;
  if (Array.isArray(attached) && attached.length > 0) return { intent: "complex", skipped: true };
  const turns = messages.map((m) => ({
    role: m.role === "user" ? ("user" as const) : ("assistant" as const),
    text: m.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("")
      .trim(),
  }));
  try {
    const res = await deps.post(
      {
        donkeyProvider: "gemini",
        model: deps.models.gate,
        instructions: GATE_PROMPT,
        input: turnIntentInput(turns),
      },
      abortSignal
    );
    if (!res.ok) return { intent: "complex", skipped: false };
    const body = (await res.json()) as { output_text?: string };
    return { intent: parseTurnIntent(body.output_text), skipped: false };
  } catch {
    return { intent: "complex", skipped: false };
  }
}

/** The newest composer message as the agent's prompt: text plus the
 * attachment doctrine block, the fresh editor snapshot, and the attachment
 * payloads as wire parts. */
async function buildPrompt(
  lastUser: UIMessage | undefined,
  deps: CutAgentDeps
): Promise<UserMessage & WireCarrier> {
  let text = (lastUser?.parts ?? [])
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("")
    .trim();
  const wireParts: WirePart[] = [];
  const meta = (lastUser?.metadata as { attachments?: unknown[] } | undefined)?.attachments;
  if (Array.isArray(meta) && meta.length > 0) {
    text += attachedAssetsBlock(meta);
    try {
      wireParts.push(...(await deps.resolveRefs(meta)));
    } catch {}
  }
  text += `\n\n<editor_state>\n${JSON.stringify(deps.buildContext())}\n</editor_state>`;
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now(), wireParts };
}

/** One chat turn on the pi harness, streamed as UI chunks. Same contract as
 * the legacy streamGeminiChat, plus the thread id that keys the session. */
export function streamCutChat({
  threadId,
  model,
  messages,
  abortSignal,
  deps,
}: {
  threadId: string;
  model: string;
  messages: UIMessage[];
  abortSignal?: AbortSignal;
  deps: CutAgentDeps;
}): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    async start(controller) {
      const emit = (chunk: Record<string, unknown>) =>
        controller.enqueue(chunk as unknown as UIMessageChunk);
      emit({ type: "start" });
      try {
        const gateStart = performance.now();
        const lastUser = messages.findLast((m) => m.role === "user");
        const promptPromise = buildPrompt(lastUser, deps);
        const verdictPromise = classifyTurnIntent(messages, deps, abortSignal);
        void verdictPromise.then(({ intent, skipped }) =>
          deps.hooks?.onGate?.(intent, performance.now() - gateStart, skipped)
        );

        const roundBudget = deps.limits?.roundBudget ?? ROUND_BUDGET;
        const maxExtensions = deps.limits?.maxExtensions ?? MAX_EXTENSIONS;
        const roundCeiling = roundBudget * (maxExtensions + 1);

        /** One full agent lifecycle: build, subscribe, prompt, run to idle.
         * The caller decides what the run streams to (live or a buffer) and
         * finalizes only the run it keeps. */
        const runAgentTurn = async ({
          roundModel,
          withTools,
          send,
          executionGate,
          onAgent,
        }: {
          roundModel: string;
          withTools: boolean;
          send: (chunk: Record<string, unknown>) => void;
          /** Awaited before any tool executes; false ends the batch unrun. */
          executionGate?: () => Promise<boolean>;
          onAgent?: (agent: Agent) => void;
        }) => {
          // The scene-plan money gate, enforced structurally: a plan created
          // this turn cannot be approved this turn, whatever the model decides.
          let scenePlannedThisTurn = false;
          let rounds = 0;
          let extensions = 0;
          // Everything this turn ran, harvested off the tool results in code.
          const records: LedgerRecord[] = [];

          const agent = new Agent({
            initialState: {
              systemPrompt: systemPrompt(),
              model: donkeyModel(roundModel),
              messages: sessionFor(threadId, messages.filter((m) => m !== lastUser)),
              tools: withTools ? toAgentTools(AI_TOOLS, deps.execTool) : [],
            },
            streamFn: makeDonkeyStream({
              post: deps.post,
              onAuthFail: deps.onAuthFail,
              noCreditsMessage: deps.noCreditsMessage,
            }),
            transformContext: async (msgs) => {
              const out = enforceContextBudget(pruneStaleMedia(pruneStaleSnapshots(msgs)));
              // The turn ledger rides every call as an ephemeral tail message —
              // the reply-writing call always sees the current record, and the
              // stored session never carries it.
              const ledger = ledgerText(records, deps.debris?.() ?? []);
              if (!ledger) return out;
              return [...out, { role: "user", content: ledger, timestamp: 0 }];
            },
            toolExecution: "sequential",
            beforeToolCall: async ({ toolCall }) => {
              if (executionGate && !(await executionGate()))
                return {
                  block: true,
                  terminate: true,
                  reason: "Rerouted — this turn is restarting on the full model.",
                };
              if (rounds >= roundCeiling)
                return {
                  block: true,
                  // The first blocked round leaves the model one round to write
                  // its reply; a model that requests tools again instead has its
                  // batch terminated, ending the turn.
                  terminate: rounds > roundCeiling,
                  reason:
                    "Step ceiling reached — no more tool calls this turn. Reply now: what is done and what remains.",
                };
              if (toolCall.name === "approve_scene" && scenePlannedThisTurn)
                return {
                  block: true,
                  reason:
                    "This plan landed this turn — the user hasn't answered yet. Ask them to confirm (they can also click Approve on the plan card), and call approve_scene only after they say yes in a later message.",
                };
              return undefined;
            },
            afterToolCall: async ({ toolCall, result, isError }) => {
              if (toolCall.name === "generate_scene" && !isError) scenePlannedThisTurn = true;
              const details = result.details as DonkeyToolDetails | undefined;
              const errorText = isError
                ? (result.content.find((c) => c.type === "text") as { text?: string } | undefined)
                    ?.text || "failed"
                : undefined;
              recordCall(records, toolCall.name, details?.response, errorText);
              return undefined;
            },
          });
          onAgent?.(agent);

          const unsubscribeUi = subscribeUiChunks(agent, send);
          // Round timing for the eval: one assistant message = one LLM round.
          const onRound = deps.hooks?.onRound;
          let roundStart = 0;
          let roundFirstDelta: number | null = null;
          const unsubscribeTiming = !onRound
            ? () => {}
            : agent.subscribe((event) => {
                if (
                  event.type === "message_start" &&
                  (event.message as Message).role === "assistant"
                ) {
                  roundStart = performance.now();
                  roundFirstDelta = null;
                } else if (
                  event.type === "message_update" &&
                  event.assistantMessageEvent.type === "text_delta" &&
                  roundFirstDelta === null &&
                  event.assistantMessageEvent.delta.trim()
                ) {
                  roundFirstDelta = performance.now() - roundStart;
                } else if (
                  event.type === "message_end" &&
                  (event.message as Message).role === "assistant" &&
                  roundStart > 0
                ) {
                  onRound(performance.now() - roundStart, roundFirstDelta);
                  roundStart = 0;
                }
              });
          const unsubscribeTurns = agent.subscribe((event) => {
            if (event.type !== "turn_end") return;
            const msg = event.message as Message;
            if (msg.role !== "assistant" || !msg.content.some((c) => c.type === "toolCall")) return;
            rounds++;
            if (rounds % roundBudget === 0 && rounds < roundCeiling && extensions < maxExtensions) {
              extensions++;
              deps.hooks?.onExtension?.(extensions);
              agent.steer({
                role: "user",
                content: `[budget] Round budget auto-extended (${extensions} of ${maxExtensions}). Keep working; finish the job or report the concrete blocker.`,
                timestamp: Date.now(),
              });
            }
          });
          const onAbort = () => agent.abort();
          abortSignal?.addEventListener("abort", onAbort);

          try {
            const prompt = { ...(await promptPromise) };
            // A signal that aborted during the gate/prompt awaits fired before
            // the listener existed; nothing has run, so the turn just ends.
            if (!abortSignal?.aborted) {
              await agent.prompt(prompt);
              await agent.waitForIdle();
            }
          } finally {
            abortSignal?.removeEventListener("abort", onAbort);
            unsubscribeUi();
            unsubscribeTiming();
            unsubscribeTurns();
          }
          return { agent, rounds, send };
        };

        /** Save and sign off the one run this turn keeps. */
        const finalize = (run: {
          agent: Agent;
          rounds: number;
          send: (chunk: Record<string, unknown>) => void;
        }) => {
          sessions.set(threadId, sanitizeSession(run.agent.state.messages));
          // The step-limit handoff guarantee: a turn that ends at the ceiling
          // with the model still requesting tools closes with readable text —
          // the terminated batch alone would leave the reply on blocked tool
          // chips with no sign-off.
          if (run.rounds > roundCeiling && !abortSignal?.aborted) {
            const last = [...run.agent.state.messages]
              .reverse()
              .find((m) => (m as Message).role === "assistant") as Message | undefined;
            const spoke =
              !!last &&
              Array.isArray(last.content) &&
              last.content.some((c) => c.type === "text" && c.text.trim());
            if (!spoke) {
              const id = crypto.randomUUID();
              run.send({ type: "text-start", id });
              run.send({
                type: "text-delta",
                id,
                delta:
                  'Paused at this turn\'s step limit with work still open. Say "keep going" to continue.',
              });
              run.send({ type: "text-end", id });
            }
          }
          const errorMessage = run.agent.state.errorMessage;
          if (errorMessage && !abortSignal?.aborted) {
            run.send({ type: "error", errorText: errorMessage });
          }
        };

        // Speculative first round: the turn goes out immediately on the light
        // model with the full catalog while the gate classifies in parallel.
        // Tool execution waits on the verdict and UI chunks buffer until it
        // lands, so a chat or complex verdict aborts the run with nothing
        // shown and nothing executed, and the turn restarts routed — while a
        // simple verdict (the common case) keeps the run and pays no gate
        // wall time at all. A message with attachments resolves complex
        // instantly, so it runs routed from the start.
        const attached = (lastUser?.metadata as { attachments?: unknown[] } | undefined)
          ?.attachments;
        let kept = false;
        if (!(Array.isArray(attached) && attached.length > 0) && !abortSignal?.aborted) {
          const buffer: Record<string, unknown>[] = [];
          let mode: "buffering" | "live" | "discarded" = "buffering";
          const send = (chunk: Record<string, unknown>) => {
            if (mode === "live") emit(chunk);
            else if (mode === "buffering") buffer.push(chunk);
          };
          let speculating: Agent | null = null;
          const watcher = verdictPromise.then(({ intent }) => {
            if (intent === "simple") {
              mode = "live";
              for (const c of buffer.splice(0)) emit(c);
              return true;
            }
            mode = "discarded";
            buffer.length = 0;
            speculating?.abort();
            return false;
          });
          const run = await runAgentTurn({
            roundModel: deps.models.simple,
            withTools: true,
            send,
            executionGate: async () => (await verdictPromise).intent === "simple",
            onAgent: (a) => {
              speculating = a;
            },
          });
          if (await watcher) {
            finalize(run);
            kept = true;
          }
        }
        if (!kept && !abortSignal?.aborted) {
          const { intent } = await verdictPromise;
          finalize(
            await runAgentTurn({
              roundModel: intent === "simple" ? deps.models.simple : model,
              withTools: intent !== "chat",
              send: emit,
            })
          );
        }
      } catch (err) {
        if (!abortSignal?.aborted) {
          emit({ type: "error", errorText: err instanceof Error ? err.message : String(err) });
        }
      } finally {
        emit({ type: "finish" });
        controller.close();
      }
    },
  });
}
