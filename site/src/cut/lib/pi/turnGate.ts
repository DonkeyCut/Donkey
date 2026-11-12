import type { UIMessage } from "ai";
import { isResumeMessage } from "../chatResume";
import { askJudge } from "../judge";
import { briefMeasures, briefSteer, openItems, splitBrief, type BriefItem, type BriefNote } from "../turnBrief";
import { editorSlice, type CutJudgeSettings, type TurnIntent } from "../turnJudge";
import {
  QUALITY_QUESTIONS,
  QUALITY_STEER_PREFIX,
  qualityState,
  qualityVerdict,
  recordLook,
  type QualityAnswers,
  type QualityVerdict,
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
    editor: editorSlice(editorOf(deps) ?? deps.buildContext()),
  };
  try {
    const { answers } = await askJudge(deps.judge, qualityState(work), QUALITY_QUESTIONS, abortSignal);
    return qualityVerdict(answers as unknown as QualityAnswers, work, settings);
  } catch {
    return null;
  }
}

/** The editor as it stands at sign-off; null while the chat's project is not
 * the one open. */
function editorOf(deps: CutAgentDeps): unknown {
  return deps.editorNow ? deps.editorNow() : deps.buildContext();
}

/** The tool whose result carries a note's body into the turn. */
const NOTE_READ = "read_note";

/** How many times each tool ran without failing. */
function ranCounts(records: LedgerRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of records) {
    if (r.error) {
      continue;
    }
    counts[r.name] = (counts[r.name] ?? 0) + 1;
  }
  return counts;
}

export class TurnGate {
  /** Everything the turn ran, harvested off the tool results in code. */
  readonly records: LedgerRecord[] = [];
  private readonly looks = new Map<string, WatchedSource>();
  private rounds = 0;
  // What the turn had looked at and run the last time the gate held it.
  private mark = "";
  // The notes this turn read, by id: the rest of its brief beside the ask. A
  // note read again replaces itself.
  private readonly notes = new Map<string, BriefNote>();
  // The brief's checklist, split once for the brief it was split from.
  private brief: { key: string; items: BriefItem[] } | null = null;
  private briefRounds = 0;

  constructor(
    private readonly ask: string,
    private intent: TurnIntent | null = null
  ) {}

  /** How many times the gate has sent the turn back. */
  get held(): number {
    return this.rounds + this.briefRounds;
  }

  /** The route the turn's judgment settled on, once it lands. */
  routed(intent: TurnIntent | null): void {
    this.intent = intent ?? this.intent;
  }

  /** One tool call the turn ran: its response, or the error it failed with. */
  record(name: string, response: unknown, errorText: string | undefined): void {
    recordCall(this.records, name, response, errorText);
    if (errorText !== undefined) {
      return;
    }
    recordLook(this.looks, name, response);
    if (name === NOTE_READ) {
      this.noteRead(response);
    }
  }

  /** The notes the turn this run continues had already read. A turn the page
   * lost resumes in a fresh run, and keeps the brief it was given. */
  carryNotes(messages: UIMessage[]): void {
    const since = messages.findLastIndex((m) => m.role === "user" && !isResumeMessage(m));
    for (const message of messages.slice(since + 1)) {
      if (message.role !== "assistant") {
        continue;
      }
      for (const part of message.parts as { type: string; state?: string; output?: unknown }[]) {
        if (part.type === `tool-${NOTE_READ}` && part.state === "output-available") {
          this.noteRead(part.output);
        }
      }
    }
  }

  // A note the turn read joins its brief: a guide @-mentioned beside a
  // one-line ask is most of what the turn was told to do.
  private noteRead(response: unknown): void {
    const note = response as { id?: unknown; title?: unknown; body?: unknown } | undefined;
    if (typeof note?.body !== "string" || !note.body.trim()) {
      return;
    }
    const id = typeof note.id === "string" ? note.id : note.body;
    this.notes.set(id, { title: typeof note.title === "string" ? note.title : "", body: note.body });
  }

  /** The verdict that sends the signing-off turn back to work, or null to let
   * it close. */
  async hold(reply: string, deps: CutAgentDeps, settings: CutJudgeSettings, signal?: AbortSignal) {
    if (!settings.qualityGate) {
      return null;
    }

    // One sent back that returns with the same record has stopped moving,
    // and sending it again would spin.
    const mark = workMark(this.records, this.looks);
    if (mark === this.mark) {
      return null;
    }

    // The footage holds go first: a turn still owing a look at its sources
    // cannot know yet whether the brief is met. The brief holds come after.
    const verdict =
      (await this.footageHold(reply, deps, settings, signal)) ?? (await this.briefHold(reply, deps, settings, signal));
    if (!verdict) {
      return null;
    }
    this.mark = mark;
    return verdict;
  }

  /** The holds that judge a turn grounded in footage. */
  private async footageHold(
    reply: string,
    deps: CutAgentDeps,
    settings: CutJudgeSettings,
    signal?: AbortSignal
  ): Promise<QualityVerdict | null> {
    if (this.rounds >= settings.qualityRounds) {
      return null;
    }

    // The gate judges work grounded in footage: a turn that looked at a
    // source can be held to what it saw. A turn that opened no source is
    // measurable too when it changed nothing — an ask for work answered in
    // words leaves the project where it was.
    if (this.looks.size === 0 && this.records.some((r) => !r.error && isMutatingTool(r.name))) {
      return null;
    }

    const verdict = await gateVerdict(reply, this.ask, this.records, this.looks, deps, settings, signal);
    if (!verdict) {
      return null;
    }
    this.rounds++;
    return verdict;
  }

  /**
   * The brief hold: everything the turn was told — the ask, and every note
   * it read — split into a checklist, and each item judged against the
   * measured editor. A complex ask, or one that came with a note, is held to
   * it; a simple ask with nothing beside it is one item the footage holds
   * already cover. Fails open: a split or a judgment that cannot be asked
   * lets the turn sign off.
   */
  private async briefHold(
    reply: string,
    deps: CutAgentDeps,
    settings: CutJudgeSettings,
    signal?: AbortSignal
  ): Promise<QualityVerdict | null> {
    if (this.briefRounds >= settings.qualityBriefRounds) {
      return null;
    }
    if (this.intent !== "complex" && this.notes.size === 0) {
      return null;
    }

    try {
      // The checklist is split once per brief; a note read after the split
      // changes the brief, and the next sign-off splits it again.
      const notes = [...this.notes.values()];
      const key = JSON.stringify([this.ask, notes]);
      if (this.brief?.key !== key) {
        this.brief = { key, items: await splitBrief(deps.post, this.ask, notes, signal) };
      }
      if (this.brief.items.length === 0) {
        return null;
      }

      // Each item judged against the editor as it now stands. A chat whose
      // project is not open has nothing current to measure.
      const live = editorOf(deps);
      if (live === null) {
        return null;
      }
      const editor = briefMeasures(live);
      const work = { items: this.brief.items, ran: ranCounts(this.records), reply, editor };
      const open = await openItems(deps.judge, work, settings, signal);
      if (open.length === 0) {
        return null;
      }
      this.briefRounds++;
      return { step: "brief", steer: briefSteer(open, editor, QUALITY_STEER_PREFIX) };
    } catch {
      return null;
    }
  }
}
