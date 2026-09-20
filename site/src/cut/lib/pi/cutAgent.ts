import type { UIMessage, UIMessageChunk } from "ai";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, UserMessage } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  areaTools,
  attachedAssetsBlock,
  CORE_TOOLS,
  REQUEST_TOOLS_DEF,
  skillRelevanceBlock,
  systemPrompt,
  TOOL_AREA_NAMES,
} from "@/cut/server/ai/catalog";
import { isResumeMessage } from "../chatResume";
import {
  BUDGET_STEER_PREFIX,
  budgetSteer,
  MAX_EXTENSIONS,
  STEP_BUDGET,
  turnClose,
} from "../turnBudget";
import { cutJudge } from "../chatRuntime";
import {
  instantAction,
  instantQuestions,
  instantSnapshot,
  instantState,
  type InstantAnswers,
  type ResolvedAction,
} from "../instantAction";
import { askJudge } from "../judge";
import {
  placeQueuedRows,
  queueTriageQuestions,
  queueTriageState,
  type QueueTriageAnswers,
  type QueueVerdict,
  type TriageAnchor,
  type TriageRow,
} from "../queueTriage";
import {
  editorSlice,
  judgeTurnState,
  routeTurn,
  TURN_JUDGE_QUESTIONS,
  type CutJudgeSettings,
  type TurnIntent,
  type TurnJudgeAnswers,
  type TurnRoute,
} from "../turnJudge";
import {
  QUALITY_QUESTIONS,
  QUALITY_STEER_PREFIX,
  qualityState,
  qualityVerdict,
  recordLook,
  type QualityAnswers,
  type QualityStep,
  type WatchedSource,
} from "../turnQuality";
import { enforceContextBudget } from "./contextBudget";
import { donkeyModel, type ChatThinkingLevel } from "./donkeyModel";
import { isMutatingTool, ledgerText, recordCall, type LedgerRecord } from "./mutationLedger";
import { makeDonkeyStream, type DonkeyToolDetails, type PostFn, type WireCarrier, type WirePart } from "./donkeyStream";
import { toAgentTools, toToolResult, type ExecTool } from "./tools";
import { subscribeUiChunks } from "./uiChunks";

// The chat turn runner on the pi agent harness. Each turn: one typed judgment
// routes the newest message (a chat verdict withholds every tool, a simple
// verdict keeps the light model; the turn declares the tool areas the judge
// picked and carries the skill document it picked), the Agent loops model
// calls and tool executions against the live editor store, and the events
// stream out as the UIMessageChunks AiPanel already consumes. The thread's LLM context is pi's
// own message list, kept per thread in the session registry — past tool calls
// replay as structured toolCall/toolResult messages, so no bookkeeping rides
// as prose the model could mimic.

// A round is one assistant message that requests tools; the budget and its
// extensions are the shared ones in lib/turnBudget. At the ceiling every
// call blocks with a reply-now instruction; a model that still requests
// tools the round after gets its batch terminated, ending the turn.

export interface CutAgentDeps {
  post: PostFn;
  /** The judge route: typed questions over a state, answered as
   * probabilities. Routes the turn and triages the queue. */
  judge: PostFn;
  /** The judgment thresholds. The page binds them from the account config;
   * the worker reads them from the global settings; unset falls back to the
   * bound value (the registry default when nothing bound one). */
  judgeSettings?: CutJudgeSettings;
  execTool: ExecTool;
  models: { simple: string; complex: string };
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
    /** The turn's route landed: the verdict, the judge's wall time, whether
     * the intent was decided on sight, and what the turn declares. */
    onGate?: (intent: TurnIntent, ms: number, skipped: boolean, route: TurnRoute & { declaredTools: number }) => void;
    /** The same judgment settled the turn to one action, run with no model
     * round; null when it did not and the loop runs. */
    onInstant?: (action: ResolvedAction | null, ms: number) => void;
    /** The model widened its catalog mid-turn: a routing miss. */
    onRequestTools?: (areas: string[]) => void;
    /** One LLM round settled: wall time, and time to its first visible delta. */
    onRound?: (ms: number, firstDeltaMs: number | null) => void;
    /** The round budget auto-extended (n = extensions so far). */
    onExtension?: (n: number) => void;
    /** The quality gate sent the turn back to work (n = times this turn). */
    onQualityGate?: (step: QualityStep, n: number) => void;
  };
}

// ---------------------------------------------------------------------------
// Session registry: each thread's pi context, hydrated from the stored thread
// and read back by the save path. Live for the page's lifetime.

const sessions = new Map<string, AgentMessage[]>();
/**
 * Threads whose context is kept in hand.
 *
 * A session is one thread's transcript, and a page that visits threads all day
 * would hold every one it opened for as long as it stayed open. Keeping the
 * recent ones is enough: `sessionFor` rebuilds a missing session out of the
 * thread's own messages, so an evicted thread costs one reconstruction on the
 * next ask and nothing else.
 */
const SESSIONS_KEPT = 8;

/** Remember a thread's context, letting go of the ones left longest ago. */
function keepSession(threadId: string, messages: AgentMessage[]): void {
  sessions.delete(threadId);
  sessions.set(threadId, messages);
  while (sessions.size > SESSIONS_KEPT) sessions.delete(sessions.keys().next().value!);
}

/** Turn-local scaffolding the session never keeps: the budget's own steer and
 * the quality gate's. Both are instructions to the run, not asks from the
 * person, so neither counts as the newest ask nor survives the save. */
function isTurnSteer(m: AgentMessage): boolean {
  const msg = m as Message;
  return (
    msg.role === "user" &&
    typeof msg.content === "string" &&
    (msg.content.startsWith(BUDGET_STEER_PREFIX) || msg.content.startsWith(QUALITY_STEER_PREFIX))
  );
}

/** A composer message folded into a running turn. It is a real ask the
 * session keeps, and it belongs to the turn it joined: the media invariant
 * treats the turn's first ask as the newest, so the payloads that turn is
 * working from stay in context when the fold lands. */
interface FoldCarrier {
  fold?: true;
}

function isFold(m: AgentMessage): boolean {
  return (m as FoldCarrier).fold === true;
}

// ---------------------------------------------------------------------------
// Live turns: the thread's running agent, so a message the triage folds in
// can be steered into it. A fold is remembered on the turn until an agent
// injects it — the speculative run may be discarded and rerun routed, and
// the fold has to reach the run the turn keeps — and a fold no agent took by
// the time the turn ends is handed back, so the page can queue it instead.

interface Fold {
  message: UserMessage & WireCarrier & FoldCarrier;
  resolve: (injected: boolean) => void;
  /** The run that last injected it; a later run built for the same turn
   * takes it again. */
  takenBy: Agent | null;
}

interface LiveTurn {
  agent: Agent | null;
  folds: Fold[];
}

const liveTurns = new Map<string, LiveTurn>();

/** Whether a turn is running on this page for the thread, so a fold can land. */
export function cutChatLive(threadId: string): boolean {
  return liveTurns.has(threadId);
}

/** Hand every fold the turn holds to a freshly built agent: the ones no run
 * has injected yet, and the ones a discarded run took with it. */
function steerFolds(turn: LiveTurn, agent: Agent): void {
  turn.agent = agent;
  for (const f of turn.folds) if (f.takenBy !== agent) agent.steer(f.message);
}

/** Watch the run inject folds; each resolves once, the first time a run
 * takes it. */
function watchFolds(turn: LiveTurn, agent: Agent): () => void {
  return agent.subscribe((event) => {
    if (event.type !== "message_start") return;
    const f = turn.folds.find((x) => x.message === event.message);
    if (!f) return;
    if (!f.takenBy) f.resolve(true);
    f.takenBy = agent;
  });
}

/** Steer a composer message into the thread's running turn. Resolves true
 * once the turn has taken the message into its context, false when the turn
 * ended first — the message then goes out as its own turn. */
export async function foldIntoCutChat({
  threadId,
  text,
  attachments,
  deps,
}: {
  threadId: string;
  text: string;
  attachments: unknown[];
  deps: CutAgentDeps;
}): Promise<boolean> {
  if (!liveTurns.has(threadId)) return false;
  const ask: UIMessage = {
    id: "",
    role: "user",
    parts: [{ type: "text", text }],
    ...(attachments.length > 0 && { metadata: { attachments } }),
  };
  const message: Fold["message"] = { ...(await buildPrompt(ask, deps)), fold: true };
  const turn = liveTurns.get(threadId);
  if (!turn) return false;
  return new Promise<boolean>((resolve) => {
    turn.folds.push({ message, resolve, takenBy: null });
    turn.agent?.steer(message);
  });
}

/** Where each mid-turn message goes: one judgment over the running ask and
 * the rows. Fails closed — every row the call cannot place stays in the
 * queue. */
export async function triageQueuedMessages({
  anchor,
  waiting,
  rows,
  deps,
  abortSignal,
}: {
  anchor: TriageAnchor;
  waiting: TriageRow[];
  rows: TriageRow[];
  deps: CutAgentDeps;
  abortSignal?: AbortSignal;
}): Promise<Map<string, QueueVerdict>> {
  // Short ids on the wire; the verdict quotes them back.
  const wire = rows.map((r, i) => ({ id: `m${i + 1}`, text: r.text }));
  const byWire = new Map(wire.map((w, i) => [w.id, rows[i].id] as const));
  let answers: QueueTriageAnswers | null = null;
  try {
    const result = await askJudge(
      deps.judge,
      queueTriageState(anchor, waiting, wire),
      queueTriageQuestions(wire),
      abortSignal
    );
    answers = result.answers as QueueTriageAnswers;
  } catch {
    answers = null;
  }
  const out = new Map<string, QueueVerdict>();
  for (const [w, v] of placeQueuedRows(answers, wire)) out.set(byWire.get(w)!, v);
  return out;
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
    if ((m as Message).role === "user" && !isTurnSteer(m) && !isFold(m)) lastAsk = i;
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
    pruneStaleMedia(pruneStaleSnapshots(messages.filter((m) => !isTurnSteer(m)))),
  );
}

// The complex role's rounds are tool orchestration over state the mutation
// ledger already grounds, so they run at the low thinking budget: at its
// default the model re-reads state after every edit and each round takes about
// half again as long, with no gain on the chat eval. The simple role keeps its
// default (the low budget slows that model and costs it a case), and so does a
// chat-verdict turn, which answers a question with no tools to orchestrate.
const COMPLEX_THINKING_LEVEL: ChatThinkingLevel = "low";

export function hydratePiSession(threadId: string, messages: AgentMessage[] | undefined): void {
  if (messages && !sessions.has(threadId)) keepSession(threadId, sanitizeSession(messages));
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

/** A message that runs on the full model from the start, with no speculative
 * round: one carrying attachments, or the continuation of a turn the page
 * lost, which picks up whatever tools that turn was using. The judge still
 * picks its skill and areas. */
function complexOnSight(lastUser: UIMessage | undefined): boolean {
  if (!lastUser) return false;
  if (isResumeMessage(lastUser)) return true;
  const attached = (lastUser.metadata as { attachments?: unknown[] } | undefined)?.attachments;
  return Array.isArray(attached) && attached.length > 0;
}

export interface TurnVerdict {
  route: TurnRoute;
  /** The intent was decided on sight (attachments, a resumed turn). */
  skipped: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The turn's route and the one action it could run without a model, judged
 * together. Both read the same state, and questions in one request are
 * answered in parallel, so the instant path costs the turn no wall time of
 * its own and no second round trip. Fails open: anything that throws — the
 * call, the snapshot, the composition — runs the full model with every area,
 * no skill and no instant action. */
export async function judgeTurnAndAction(
  messages: UIMessage[],
  context: unknown,
  deps: CutAgentDeps,
  abortSignal?: AbortSignal
): Promise<{ verdict: TurnVerdict; instant: ResolvedAction | null }> {
  const settings = deps.judgeSettings ?? cutJudge();
  const lastUser = messages.findLast((m) => m.role === "user");
  const onSight = complexOnSight(lastUser);
  if (onSight && !settings.skillSuggestion && !settings.toolRouting)
    return { verdict: { route: routeTurn(null, settings), skipped: true }, instant: null };

  let route: TurnRoute;
  let instant: ResolvedAction | null = null;
  try {
    // An attachment or a resumed turn is never one known action on its own.
    const snap = instantSnapshot(context);
    const instantQs = onSight || !settings.instantAction ? {} : instantQuestions(snap);
    const { answers } = await askJudge(
      deps.judge,
      instantState(messages, context),
      { ...TURN_JUDGE_QUESTIONS, ...instantQs },
      abortSignal
    );
    route = routeTurn(answers as unknown as TurnJudgeAnswers, settings);
    if (Object.keys(instantQs).length > 0)
      instant = instantAction(answers as unknown as InstantAnswers, snap, settings);
  } catch {
    route = routeTurn(null, settings);
    instant = null;
  }
  if (onSight) route.intent = "complex";
  return { verdict: { route, skipped: onSight }, instant };
}

/** The skill the judge attaches to a turn the engine's own chat runs: the
 * page judges before the send and the engine carries the block on its
 * prompt. Null when no skill fits; undefined when the judge could not be
 * asked. */
export async function judgeEngineSkill(
  messages: UIMessage[],
  context: unknown,
  deps: CutAgentDeps
): Promise<string | null | undefined> {
  const settings = deps.judgeSettings ?? cutJudge();
  if (!settings.skillSuggestion) return undefined;
  try {
    const { answers } = await askJudge(deps.judge, judgeTurnState(messages, context), TURN_JUDGE_QUESTIONS);
    return routeTurn(answers as unknown as TurnJudgeAnswers, settings).skill;
  } catch {
    return undefined;
  }
}

/** The declared catalog for a run: the core on every work turn, the routed
 * areas' tools, and the escape hatch whenever something was left out. */
function toolsFor(areas: readonly string[], execTool: ExecTool, requestTools: AgentTool): AgentTool[] {
  const full = areas.length === TOOL_AREA_NAMES.length;
  return [
    ...toAgentTools([...CORE_TOOLS, ...areaTools(areas)], execTool),
    ...(full ? [] : [requestTools]),
  ];
}

/** The newest composer message as the agent's prompt: text plus the
 * attachment doctrine block, the fresh editor snapshot, and the attachment
 * payloads as wire parts. */
async function buildPrompt(
  lastUser: UIMessage | undefined,
  deps: CutAgentDeps,
  context: unknown = deps.buildContext()
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
  text += `\n\n<editor_state>\n${JSON.stringify(context)}\n</editor_state>`;
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now(), wireParts };
}

/** The usage a synthesized assistant message carries: none, because no model
 * ran. Same template the legacy-thread converter uses. */
const NO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

/** Run the action the judgment settled on, stream it as the chunks a
 * single-tool turn emits, and leave the thread's context holding the ask,
 * the call, its result and the line — the four messages a model round would
 * have written. False when the tool threw, and the caller runs the loop. */
async function runInstantAction(
  action: ResolvedAction,
  ctx: {
    threadId: string;
    messages: UIMessage[];
    lastUser: UIMessage | undefined;
    prompt: UserMessage & WireCarrier;
    deps: CutAgentDeps;
    emit: (chunk: Record<string, unknown>) => void;
  }
): Promise<boolean> {
  const { threadId, messages, lastUser, prompt, deps, emit } = ctx;
  const toolCallId = crypto.randomUUID();
  let output: unknown;
  try {
    output = await deps.execTool(action.tool, action.args);
  } catch {
    return false;
  }
  const result = toToolResult(action.tool, output);
  emit({ type: "tool-input-available", toolCallId, toolName: action.tool, input: action.args });
  emit({ type: "tool-output-available", toolCallId, output: result.details?.response ?? null });
  emit({ type: "text-start", id: "t1" });
  emit({ type: "text-delta", id: "t1", delta: action.say });
  emit({ type: "text-end", id: "t1" });

  const now = Date.now();
  const session: AgentMessage[] = [
    ...sessionFor(threadId, messages.filter((m) => m !== lastUser)),
    prompt as AgentMessage,
    {
      role: "assistant",
      content: [{ type: "toolCall", id: toolCallId, name: action.tool, arguments: action.args }],
      api: "donkey-responses",
      provider: "donkey",
      model: "",
      usage: NO_USAGE,
      stopReason: "toolUse",
      timestamp: now,
    } as AgentMessage,
    {
      role: "toolResult",
      toolCallId,
      toolName: action.tool,
      content: result.content,
      details: result.details,
      isError: false,
      timestamp: now,
    } as AgentMessage,
    {
      role: "assistant",
      content: [{ type: "text", text: action.say }],
      api: "donkey-responses",
      provider: "donkey",
      model: "",
      usage: NO_USAGE,
      stopReason: "stop",
      timestamp: now,
    } as AgentMessage,
  ];
  keepSession(threadId, sanitizeSession(session));
  return true;
}

/** The turn's own work, judged before it closes. Fails open: a judgment that
 * cannot be asked lets the turn sign off. */
async function gateVerdict(
  reply: Message,
  request: string,
  records: LedgerRecord[],
  looks: Map<string, WatchedSource>,
  deps: CutAgentDeps,
  settings: CutJudgeSettings,
  abortSignal?: AbortSignal
) {
  const work = {
    request,
    reply: Array.isArray(reply.content)
      ? reply.content
          .map((c) => (c.type === "text" ? c.text : ""))
          .join("")
          .trim()
      : "",
    ran: [...new Set(records.filter((r) => !r.error).map((r) => r.name))],
    failed: [...new Set(records.filter((r) => r.error).map((r) => `${r.name} (${r.error})`))],
    mutated: records.some((r) => !r.error && isMutatingTool(r.name)),
    sources: [...looks.values()],
    editor: editorSlice(deps.buildContext()),
  };
  try {
    const { answers } = await askJudge(deps.judge, qualityState(work), QUALITY_QUESTIONS, abortSignal);
    return qualityVerdict(answers as unknown as QualityAnswers, work, settings);
  } catch {
    return null;
  }
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
      const turn: LiveTurn = { agent: null, folds: [] };
      liveTurns.set(threadId, turn);
      try {
        const gateStart = performance.now();
        const lastUser = messages.findLast((m) => m.role === "user");
        const askText = (lastUser?.parts ?? [])
          .map((p) => (p.type === "text" ? p.text : ""))
          .join("")
          .trim();
        const context = deps.buildContext();
        const promptPromise = buildPrompt(lastUser, deps, context);
        const settings = deps.judgeSettings ?? cutJudge();
        // One judgment settles both: how the turn is routed, and whether it
        // is a single known action the editor can carry out on its own.
        const decision = judgeTurnAndAction(messages, context, deps, abortSignal);
        const verdictPromise = decision.then((d) => d.verdict);
        // The route once it has landed, read by every round after.
        let settled: TurnRoute | null = null;
        void decision
          .then(({ verdict: { route, skipped }, instant }) => {
            settled = route;
            const ms = performance.now() - gateStart;
            deps.hooks?.onGate?.(route.intent, ms, skipped, {
              ...route,
              declaredTools: route.intent === "chat" ? 0 : CORE_TOOLS.length + areaTools(route.areas).length,
            });
            deps.hooks?.onInstant?.(instant, ms);
          })
          // This branch only reports. The turn reads the decision through
          // its own awaits, inside the try that answers the user.
          .catch(() => {});

        const roundBudget = deps.limits?.roundBudget ?? STEP_BUDGET;
        const maxExtensions = deps.limits?.maxExtensions ?? MAX_EXTENSIONS;
        const roundCeiling = roundBudget * (maxExtensions + 1);

        /** One full agent lifecycle: build, subscribe, prompt, run to idle.
         * The caller decides what the run streams to (live or a buffer) and
         * finalizes only the run it keeps. */
        const runAgentTurn = async ({
          roundModel,
          thinkingLevel,
          withTools,
          send,
          executionGate,
          cancelled,
          onAgent,
        }: {
          roundModel: string;
          thinkingLevel?: ChatThinkingLevel;
          withTools: boolean;
          send: (chunk: Record<string, unknown>) => void;
          /** Awaited before any tool executes; false ends the batch unrun. */
          executionGate?: () => Promise<boolean>;
          /** True once the run has been abandoned, so it never goes out. */
          cancelled?: () => boolean;
          onAgent?: (agent: Agent) => void;
        }) => {
          // The scene-plan money gate, enforced structurally: a plan created
          // this turn cannot be approved this turn, whatever the model decides.
          let scenePlannedThisTurn = false;
          let rounds = 0;
          let extensions = 0;
          // Everything this turn ran, harvested off the tool results in code.
          const records: LedgerRecord[] = [];
          // What this turn has looked at, and how many times the quality gate
          // has already sent it back to work.
          const looks = new Map<string, WatchedSource>();
          let gateRounds = 0;
          // What the turn had looked at and run the last time the gate held
          // it. A turn that comes back with the same record has stopped
          // moving, and sending it back again would only spin.
          let gateMark = "";

          // The catalog this run declares. The speculative run waits a bounded
          // moment for the route; a route that has landed narrows the tools
          // to its areas, and one still in flight leaves the full catalog on
          // this run (the model already sees those tools, so the run never
          // narrows afterwards). The escape hatch widens between rounds.
          const routed =
            settled ?? (await Promise.race([verdictPromise.then((v) => v.route), sleep(settings.judgeWaitMs).then(() => null)]));
          const declared = new Set<string>(routed?.areas ?? TOOL_AREA_NAMES);
          let widened: string[] | null = null;
          const requestTools: AgentTool = {
            name: REQUEST_TOOLS_DEF.name,
            label: REQUEST_TOOLS_DEF.name,
            description: REQUEST_TOOLS_DEF.description,
            parameters: REQUEST_TOOLS_DEF.inputSchema as never,
            execute: async (_id, params) => {
              const asked = ((params as { areas?: unknown }).areas ?? []) as unknown[];
              const added = asked.filter((a): a is string => typeof a === "string" && TOOL_AREA_NAMES.includes(a) && !declared.has(a));
              for (const a of added) declared.add(a);
              if (added.length > 0) {
                widened = [...(widened ?? []), ...added];
                deps.hooks?.onRequestTools?.(added);
              }
              const tools = areaTools(added).map((t) => t.name);
              return toToolResult(REQUEST_TOOLS_DEF.name, {
                added,
                tools,
                note: added.length > 0 ? "Available from your next step." : "Nothing to add: those areas are already declared.",
              });
            },
          };
          const tools = withTools ? toolsFor([...declared], deps.execTool, requestTools) : [];

          const agent = new Agent({
            initialState: {
              systemPrompt: systemPrompt(),
              model: donkeyModel(roundModel, thinkingLevel),
              messages: sessionFor(threadId, messages.filter((m) => m !== lastUser)),
              tools,
            },
            // A widened catalog reaches the next round through the loop's own
            // context, and the agent's state, so a follow-up sees it too.
            prepareNextTurnWithContext: (ctx) => {
              if (!widened) return undefined;
              widened = null;
              const next = toolsFor([...declared], deps.execTool, requestTools);
              agent.state.tools = next;
              return { context: { ...ctx.context, tools: next } };
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
              // The skill the judge attached rides the same way, from the
              // first round it is known for.
              const skill = withTools && settings.skillSuggestion && settled ? skillRelevanceBlock(settled.skill) : null;
              const ledger = ledgerText(records, deps.debris?.() ?? []);
              const tail = [skill, ledger].filter((t): t is string => !!t).join("\n\n");
              if (!tail) return out;
              return [...out, { role: "user", content: tail, timestamp: 0 }];
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
              if (!isError) recordLook(looks, toolCall.name, details?.response);
              return undefined;
            },
            // The quality gate: a round that asks for no tools is the turn
            // signing off, and a turn built on footage only gets to when the
            // looking behind it holds up. The judgment reads the record the
            // turn built — what it watched and wrote down, what ran, the
            // editor as it now stands, and the line it is about to close on —
            // and a verdict that finds the job unfinished queues the next step
            // as a follow-up, which the loop picks up instead of ending.
            // Never stops the loop itself: the step budget and the ceiling
            // own that, and the gate stands down near the ceiling so it can
            // never push a turn into the paused handoff.
            shouldStopAfterTurn: async ({ message }) => {
              const msg = message as Message;
              if (
                !withTools ||
                abortSignal?.aborted ||
                cancelled?.() ||
                gateRounds >= settings.qualityRounds ||
                !settings.qualityGate ||
                rounds >= roundCeiling - 1 ||
                (Array.isArray(msg.content) && msg.content.some((c) => c.type === "toolCall"))
              )
                return false;
              // The gate judges work grounded in footage: a turn that looked
              // at a source can be held to what it saw. A turn that opened no
              // source is measurable too when it changed nothing — an ask for
              // work answered in words leaves the project where it was, and
              // that is a fact the record carries.
              if (looks.size === 0 && records.some((r) => !r.error && isMutatingTool(r.name))) return false;
              const mark = [
                records.length,
                ...[...looks.values()].map((l) => `${l.passes}:${l.coveredTo}:${l.observed.length}`),
              ].join("|");
              if (mark === gateMark) return false; // sent back once, nothing moved
              const verdict = await gateVerdict(msg, askText, records, looks, deps, settings, abortSignal);
              if (!verdict) return false;
              gateMark = mark;
              gateRounds++;
              deps.hooks?.onQualityGate?.(verdict.step, gateRounds);
              agent.followUp({ role: "user", content: verdict.steer, timestamp: Date.now() });
              return false;
            },
          });
          onAgent?.(agent);
          steerFolds(turn, agent);
          const unsubscribeFolds = watchFolds(turn, agent);

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
                content: budgetSteer(extensions, maxExtensions),
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
            // A verdict that landed during those same awaits abandoned this
            // run before it had an agent to abort, so it never goes out.
            if (!abortSignal?.aborted && !cancelled?.()) {
              await agent.prompt(prompt);
              await agent.waitForIdle();
            }
          } finally {
            abortSignal?.removeEventListener("abort", onAbort);
            unsubscribeUi();
            unsubscribeTiming();
            unsubscribeTurns();
            unsubscribeFolds();
          }
          return { agent, rounds, send };
        };

        /** Save and sign off the one run this turn keeps. */
        const finalize = (run: {
          agent: Agent;
          rounds: number;
          send: (chunk: Record<string, unknown>) => void;
        }) => {
          keepSession(threadId, sanitizeSession(run.agent.state.messages));
          const errorMessage = run.agent.state.errorMessage;
          // The handoff guarantee, the same one every provider keeps: a turn
          // that ends at the ceiling with the model still requesting tools,
          // or ends saying nothing at all, closes with readable text — the
          // terminated batch alone would leave the reply on blocked tool
          // chips with no sign-off.
          const last = [...run.agent.state.messages]
            .reverse()
            .find((m) => (m as Message).role === "assistant") as Message | undefined;
          const spoke =
            !!last &&
            Array.isArray(last.content) &&
            last.content.some((c) => c.type === "text" && c.text.trim());
          const close = abortSignal?.aborted
            ? null
            : turnClose({
                end: errorMessage ? "failed" : run.rounds > roundCeiling ? "budget" : "done",
                spoke,
                // At the ceiling the extensions are all spent, so this is the
                // handoff rather than more budget.
                extensions: maxExtensions,
                maxExtensions,
              });
          if (close && "signoff" in close) {
            const id = crypto.randomUUID();
            run.send({ type: "text-start", id });
            run.send({ type: "text-delta", id, delta: close.signoff });
            run.send({ type: "text-end", id });
          }
          if (errorMessage && !abortSignal?.aborted) {
            run.send({ type: "error", errorText: errorMessage });
          }
        };

        // Speculative first round: the turn goes out on the light model while
        // the judge routes in parallel, waiting on it only a bounded moment for
        // the narrowed catalog.
        // Tool execution waits on the verdict and UI chunks buffer until it
        // lands, so a chat or complex verdict aborts the run with nothing
        // shown and nothing executed, and the turn restarts routed — while a
        // simple verdict (the common case) keeps the run and pays no gate
        // wall time at all. A message complex on sight runs routed from
        // the start.
        let kept = false;
        if (!complexOnSight(lastUser) && !abortSignal?.aborted) {
          const buffer: Record<string, unknown>[] = [];
          let mode: "buffering" | "live" | "discarded" = "buffering";
          const send = (chunk: Record<string, unknown>) => {
            if (mode === "live") emit(chunk);
            else if (mode === "buffering") buffer.push(chunk);
          };
          let speculating: Agent | null = null;
          // The verdict usually lands while the run is still awaiting its
          // route, before there is an agent to abort, so the discard is a
          // flag the run reads as well as an abort it may not receive.
          let discarded = false;
          const watcher = decision.then(({ verdict: { route }, instant }) => {
            if (!instant && route.intent === "simple") {
              mode = "live";
              for (const c of buffer.splice(0)) emit(c);
              return true;
            }
            mode = "discarded";
            discarded = true;
            buffer.length = 0;
            speculating?.abort();
            return false;
          });
          const run = await runAgentTurn({
            roundModel: deps.models.simple,
            withTools: true,
            send,
            executionGate: async () => {
              const d = await decision;
              return !d.instant && d.verdict.route.intent === "simple";
            },
            cancelled: () => discarded,
            onAgent: (a) => {
              speculating = a;
              if (discarded) a.abort();
            },
          });
          if (await watcher) {
            finalize(run);
            kept = true;
          }
        }
        // The instant path: the judgment settled the turn to one action, so
        // the editor runs it and writes the line, with no model round at all.
        // The chunks are the ones a single-tool turn emits, in the same
        // order, so the chip, the timing readout and the transcript are
        // identical. A tool that throws is discarded whole — the loop runs
        // instead and the model reports the failure properly.
        const instant = (await decision).instant;
        if (!kept && instant && !abortSignal?.aborted) {
          const done = await runInstantAction(instant, {
            threadId,
            messages,
            lastUser,
            prompt: await promptPromise,
            deps,
            emit,
          });
          kept = done;
        }
        if (!kept && !abortSignal?.aborted) {
          const { intent } = (await verdictPromise).route;
          finalize(
            await runAgentTurn({
              roundModel: intent === "simple" ? deps.models.simple : model,
              thinkingLevel: intent === "complex" ? COMPLEX_THINKING_LEVEL : undefined,
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
        if (liveTurns.get(threadId) === turn) liveTurns.delete(threadId);
        // A fold no run took goes back to the page, which queues it.
        for (const f of turn.folds) if (!f.takenBy) f.resolve(false);
        emit({ type: "finish" });
        controller.close();
      }
    },
  });
}
