import type { UIMessage, UIMessageChunk } from "ai";
import type { EngineRoute, HandledAsk } from "@/cut/server/ai/turnCatalog";
import { cutJudge } from "../chatRuntime";
import type { ResolvedAction } from "../instantAction";
import { messageText } from "../messageText";
import { judgeTurnAndAction, playInstant, type CutAgentDeps } from "./cutAgent";
import { toToolResult } from "./tools";
import { TurnGate } from "./turnGate";

// A Claude or Codex turn judged the way a Gemini turn is. The page asks the
// judge before the send: a turn settled to one known action runs in the
// editor with no model round, and any other turn goes to the engine with its
// route — the declared tool areas and the skill to attach. While the CLI
// works, the page records what its tool calls ran and watched, and answers
// the engine's quality gate when the turn signs off. Only an account with
// credits is judged; the rest send unrouted and the model decides.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** What the judgment settled for an engine turn. */
interface EngineDecision {
  route: EngineRoute;
  instant: ResolvedAction | null;
}

/** The turn's route and instant action. Null when the judgment did not land
 * within the wait the hosted loop gives it: the turn then goes out unrouted. */
export async function judgeEngineTurn(
  messages: UIMessage[],
  deps: CutAgentDeps,
  signal?: AbortSignal
): Promise<EngineDecision | null> {
  const settings = deps.judgeSettings ?? cutJudge();
  const decision = judgeTurnAndAction(messages, deps.buildContext(), deps, signal);
  const landed = await Promise.race([decision, sleep(settings.judgeWaitMs).then(() => null)]);
  if (!landed) {
    return null;
  }

  const { route } = landed.verdict;
  return {
    route: {
      intent: route.intent,
      areas: route.areas,
      ...(settings.skillSuggestion && { skill: route.skill }),
      // A chat verdict runs with no tools, so it has no work to hold up: the
      // hosted loop skips the gate for it too.
      gate: settings.qualityGate && route.intent !== "chat",
    },
    instant: landed.instant,
  };
}

/** The settled action as a finished turn: the editor runs it and the stream
 * carries the chunks a single-tool turn emits. The message is marked handled
 * so the provider's session hears of it on the next send. Null when the tool
 * threw, and the turn goes to the engine instead. */
export async function engineInstant(
  action: ResolvedAction,
  deps: CutAgentDeps
): Promise<ReadableStream<UIMessageChunk> | null> {
  const chunks: Record<string, unknown>[] = [];
  const played = await playInstant(action, deps, (chunk) => chunks.push(chunk));
  if (!played) {
    return null;
  }

  const handled: Omit<HandledAsk, "ask"> = { tool: action.tool, args: action.args, say: action.say };
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      const all = [{ type: "start", messageMetadata: { handled } }, ...chunks, { type: "finish" }];
      for (const chunk of all) controller.enqueue(chunk as unknown as UIMessageChunk);
      controller.close();
    },
  });
}

/** The handled asks since the provider's last turn, oldest first: the run of
 * handled assistant messages that ends just before the newest message. */
export function handledSince(messages: UIMessage[]): HandledAsk[] {
  const out: HandledAsk[] = [];
  for (let i = messages.length - 2; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") {
      continue;
    }
    const handled = (message.metadata as { handled?: Omit<HandledAsk, "ask"> } | undefined)?.handled;
    if (!handled) {
      break;
    }
    const before = messages[i - 1];
    const ask = before?.role === "user" ? messageText(before) : "";
    out.unshift({ ask, ...handled });
  }
  return out;
}

/**
 * The quality gate for one engine turn. The page executes every tool call
 * the CLI makes, so it keeps the turn's record here; when the engine asks at
 * sign-off, the record and the reply are judged the way the hosted loop
 * judges them.
 */
export class EngineGate {
  private readonly gate: TurnGate;
  // The gates this turn answered. A reconnect replays the turn's journal from
  // its start, and an answered gate must not be judged or billed again.
  private readonly answered = new Set<string>();

  constructor(ask: string) {
    this.gate = new TurnGate(ask);
  }

  /** One tool call the page ran for the turn. */
  record(name: string, output: unknown, errorText: string | undefined): void {
    const response = errorText === undefined ? toToolResult(name, output).details?.response : undefined;
    this.gate.record(name, response, errorText);
  }

  /** The steer for the turn's next pass, null to let it close, or undefined
   * for a gate this turn already answered. */
  async steer(gateId: string, reply: string, deps: CutAgentDeps, signal?: AbortSignal): Promise<string | null | undefined> {
    if (this.answered.has(gateId)) {
      return undefined;
    }
    this.answered.add(gateId);

    const verdict = await this.gate.hold(reply, deps, deps.judgeSettings ?? cutJudge(), signal);
    return verdict?.steer ?? null;
  }
}
