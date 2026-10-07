import { askJudge } from "../judge";
import { editorSlice, type CutJudgeSettings } from "../turnJudge";
import {
  QUALITY_QUESTIONS,
  qualityState,
  qualityVerdict,
  recordLook,
  type QualityAnswers,
  type WatchedSource,
} from "../turnQuality";
import type { CutAgentDeps } from "./cutAgent";
import { isMutatingTool, recordCall, type LedgerRecord } from "./mutationLedger";

// The quality gate one turn runs when it signs off, shared by the hosted loop
// and the engine turns the page answers for. It keeps the turn's record —
// what ran, what it watched — and judges that record and the closing reply
// against the ask under the rounds cap and the stand-downs.

/** What the turn has looked at and run, as a mark. A turn the gate sent back
 * that returns with the same mark has stopped moving. */
function workMark(records: LedgerRecord[], looks: Map<string, WatchedSource>): string {
  return [
    records.length,
    ...[...looks.values()].map((l) => `${l.passes}:${l.coveredTo}:${l.observed.length}`),
  ].join("|");
}

/** The turn's own work, judged before it closes. Fails open: a judgment that
 * cannot be asked lets the turn sign off. */
async function gateVerdict(
  reply: string,
  request: string,
  records: LedgerRecord[],
  looks: Map<string, WatchedSource>,
  deps: CutAgentDeps,
  settings: CutJudgeSettings,
  abortSignal?: AbortSignal
) {
  const work = {
    request,
    reply: reply.trim(),
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

export class TurnGate {
  /** Everything the turn ran, harvested off the tool results in code. */
  readonly records: LedgerRecord[] = [];
  private readonly looks = new Map<string, WatchedSource>();
  private rounds = 0;
  // What the turn had looked at and run the last time the gate held it.
  private mark = "";

  constructor(private readonly ask: string) {}

  /** How many times the gate has sent the turn back. */
  get held(): number {
    return this.rounds;
  }

  /** One tool call the turn ran: its response, or the error it failed with. */
  record(name: string, response: unknown, errorText: string | undefined): void {
    recordCall(this.records, name, response, errorText);
    if (errorText === undefined) {
      recordLook(this.looks, name, response);
    }
  }

  /** The verdict that sends the signing-off turn back to work, or null to let
   * it close. */
  async hold(reply: string, deps: CutAgentDeps, settings: CutJudgeSettings, signal?: AbortSignal) {
    if (!settings.qualityGate || this.rounds >= settings.qualityRounds) {
      return null;
    }

    // The gate judges work grounded in footage: a turn that looked at a
    // source can be held to what it saw. A turn that opened no source is
    // measurable too when it changed nothing — an ask for work answered in
    // words leaves the project where it was. One sent back that returns with
    // the same record has stopped moving, and sending it again would spin.
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
    return verdict;
  }
}
