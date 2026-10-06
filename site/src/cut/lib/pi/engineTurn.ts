import type { UIMessage, UIMessageChunk } from "ai";
import type { EngineRoute, HandledAsk } from "@/cut/server/ai/turnCatalog";
import { cutJudge } from "../chatRuntime";
import type { ResolvedAction } from "../instantAction";
import { recordLook, type WatchedSource } from "../turnQuality";
import { gateVerdict, judgeTurnAndAction, playInstant, workMark, type CutAgentDeps } from "./cutAgent";
import { isMutatingTool, recordCall, type LedgerRecord } from "./mutationLedger";
import { toToolResult } from "./tools";

// A Claude or Codex turn judged the way a Gemini turn is. The page asks the
// judge before the send: a turn settled to one known action runs in the
// editor with no model round, and any other turn goes to the engine with its
// route — the declared tool areas and the skill to attach. While the CLI
// works, the page records what its tool calls ran and watched, and answers
// the engine's quality gate when the turn signs off. Only an account with
// credits is judged; the rest send unrouted and the model decides.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** What the judgment settled for an engine turn. */
export interface EngineDecision {
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
      gate: settings.qualityGate,
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
    const ask = before?.role === "user" ? before.parts.map((p) => (p.type === "text" ? p.text : "")).join("").trim() : "";
    out.unshift({ ask, ...handled });
  }
  return out;
}

/**
 * The quality gate for one engine turn. The page executes every tool call
 * the CLI makes, so it keeps the turn's record here; when the engine asks at
 * sign-off, the record and the reply are judged the way the hosted loop
 * judges them, under the same rounds cap and the same stand-downs.
 */
export class EngineGate {
  private records: LedgerRecord[] = [];
  private looks = new Map<string, WatchedSource>();
  private rounds = 0;
  private mark = "";

  constructor(private readonly ask: string) {}

  /** One tool call the page ran for the turn. */
  record(name: string, output: unknown, errorText: string | undefined): void {
    const response = errorText === undefined ? toToolResult(name, output).details?.response : undefined;
    recordCall(this.records, name, response, errorText);
    if (errorText === undefined) {
      recordLook(this.looks, name, response);
    }
  }

  /** The steer for the turn's next pass, or null to let it close. */
  async steer(reply: string, deps: CutAgentDeps, signal?: AbortSignal): Promise<string | null> {
    const settings = deps.judgeSettings ?? cutJudge();
    if (!settings.qualityGate || this.rounds >= settings.qualityRounds) {
      return null;
    }

    // The hosted loop's stand-downs: a turn that changed the project without
    // looking at a source has nothing measurable, and one sent back that
    // returns with the same record has stopped moving.
    if (this.looks.size === 0 && this.records.some((r) => !r.error && isMutatingTool(r.name))) {
      return null;
    }
    const mark = workMark(this.records, this.looks);
    if (mark === this.mark) {
      return null;
    }

    const verdict = await gateVerdict(reply, this.ask, this.records, this.looks, deps, settings, signal);
    if (!verdict) {
      return null;
    }
    this.mark = mark;
    this.rounds++;
    return verdict.steer;
  }
}
