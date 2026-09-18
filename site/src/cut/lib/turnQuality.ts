import type { Entry, NoulAnswer, ChoiceAnswer } from "./judge";
import { choice, noul } from "./judge";
import type { Settings } from "@/lib/config/registry";

// The quality gate: a turn built on footage, judged before it is allowed to
// close. One typed judgment reads the ask, what the turn watched and wrote
// down, what it ran, and the line it is about to sign off with; code composes
// the verdict under the `cutJudge` thresholds and hands the turn its next
// step. A turn that watched a slice of a source and is about to describe the
// whole of it, or that read a reference and left the cut it promised
// unbuilt, goes back to work before it replies.
//
// The looking is what makes the judgment measurable — coverage, notes and
// cuts are numbers the turn cannot argue with — so a turn that opened no
// source is never held here.
//
// The judgment reads the record in fields, never the user's words for intent
// — the request is state to judge against, and every threshold and cap lives
// in the settings registry.

export type CutJudgeSettings = Settings["cutJudge"];

/** What one source has given up so far, harvested off this turn's own watch
 * and note results. */
export interface WatchedSource {
  name: string;
  duration: number;
  /** Watch passes this turn. */
  passes: number;
  /** How far coverage reaches, and how much of the source nobody has seen. */
  coveredTo: number;
  unwatched: number;
  /** Source spans nothing is written about yet. */
  unnoted: { from: number; to: number }[];
  /** The written record: what someone looked at and wrote down. */
  observed: { from: number; to: number; text: string }[];
  /** Hard cuts the passes found. */
  cuts: number;
}

/** The turn as the gate sees it. */
export interface TurnWork {
  /** The newest ask. */
  request: string;
  /** The line the turn is about to close on. */
  reply: string;
  /** Tools this turn ran, and the ones that failed. */
  ran: string[];
  failed: string[];
  /** Sources this turn looked at. */
  sources: WatchedSource[];
  /** The editor as it stands now. */
  editor: Entry;
}

const TEXT_CAP = 2000;
const NOTE_CAP = 600;
const NOTES_PER_SOURCE = 12;

/** The state the judge reads. No urls, no media, no frames — the record in
 * fields, so the same judgment holds in the page and in the worker. */
export function qualityState(work: TurnWork): Entry {
  return {
    request: work.request.slice(0, TEXT_CAP),
    reply: work.reply.slice(0, TEXT_CAP),
    ran: work.ran,
    failed: work.failed,
    sources: work.sources.map((s) => ({
      name: s.name,
      duration: s.duration,
      passesThisTurn: s.passes,
      seenThrough: s.coveredTo,
      secondsNeverSeen: s.unwatched,
      spansWithNoNote: s.unnoted.slice(0, 8),
      cutsFound: s.cuts,
      observed: s.observed
        .slice(0, NOTES_PER_SOURCE)
        .map((n) => ({ from: n.from, to: n.to, text: n.text.slice(0, NOTE_CAP) })),
    })),
    editor: work.editor,
  };
}

export const QUALITY_QUESTIONS = {
  finished: noul(
    "Is the job `request` asks for actually finished in `editor`? Judge the editor's state and `ran`, not the reply's account of it.",
    {
      true: "Everything the request named exists in the editor now; the request asked for nothing to be built — a question, a look at the footage, a conversation; or it asks for something this editor refuses and the reply says so plainly.",
      false:
        "Part of the ask is missing, only planned, or only described in words: shots the reply says it would lay down that no item shows, text the reference has that no title carries, a build stopped halfway.",
    },
  ),
  seen: noul(
    "Has enough of the footage been watched AND written down for `request`? `secondsNeverSeen` is source nobody has looked at; `observed` is the written record.",
    {
      true: "The record covers what the ask depends on: an ask about one moment needs that moment, an ask about the whole source needs the whole source seen and noted.",
      false:
        "The ask leans on footage nobody has looked at — describing, summarizing, reproducing or rebuilding a source with seconds never seen, or with looked-at stretches nothing is written about.",
    },
  ),
  honest: noul(
    "Does `reply` claim only what `ran`, `observed` and `editor` support?",
    {
      true: "Every claim traces to something the record holds.",
      false:
        "The reply describes a source as a whole from a slice of it, quotes on-screen text nothing recorded, or reports work no call in `ran` performed.",
    },
  ),
  closeness: choice(
    "How closely does `request` need the footage read?",
    {
      shape: "Its shape only — where the cuts fall, roughly what each stretch holds.",
      normal: "What happens, shot by shot.",
      exact:
        "Word for word and frame by frame: reproducing, replicating or matching the source — its on-screen text, type, placement and motion.",
    },
  ),
} as const;

export type QualityAnswers = {
  finished: NoulAnswer;
  seen: NoulAnswer;
  honest: NoulAnswer;
  closeness: ChoiceAnswer<Record<"shape" | "normal" | "exact", string>>;
};

export type QualityStep = "watch" | "repair";

export interface QualityVerdict {
  step: QualityStep;
  /** The instruction the turn goes back to work on. */
  steer: string;
}

/** Turn-local scaffolding: the prefix marks the steer so the save path keeps
 * it out of the stored session. */
export const QUALITY_STEER_PREFIX = "[quality]";

/** The sampling floor the next look runs at, from how closely the ask needs
 * the footage read. */
function intervalFor(closeness: QualityAnswers["closeness"]["choice"]): number {
  return closeness === "exact" ? 0.5 : closeness === "normal" ? 2 : 15;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** What the turn has already put in the editor, named in the steer. A turn
 * sent back to look does not start the build over: told nothing, it lays the
 * same shots down again and the cut comes out as long as the number of passes
 * it took. */
function standing(work: TurnWork): string {
  const e = work.editor as { clips?: unknown; overlayKinds?: unknown };
  const clips = typeof e.clips === "number" ? e.clips : 0;
  const kinds = Array.isArray(e.overlayKinds) ? e.overlayKinds.length : 0;
  if (clips === 0 && kinds === 0) return "";
  const built = [clips > 0 ? `${clips} clips` : "", kinds > 0 ? "elements" : ""]
    .filter(Boolean)
    .join(" and ");
  return ` The timeline already holds ${built} from this turn — keep them and carry on from there; laying the same work down again doubles the cut.`;
}

/** The source with the most left to see, which is where the next pass goes. */
function thinnest(sources: WatchedSource[]): WatchedSource | null {
  let worst: WatchedSource | null = null;
  for (const s of sources) if (!worst || s.unwatched > worst.unwatched) worst = s;
  return worst && worst.unwatched > 0.5 ? worst : null;
}

/**
 * What the turn owes before it can close, composed in code from the
 * probabilities. Null means sign off.
 *
 * The judgment opens the question and the record answers it: a doubt about
 * the work, the looking or the reply only holds the turn when something
 * measured stands behind it — source seconds nobody has looked at, or calls
 * that did not land. The instruction is built from that state, so it carries
 * real numbers: which source, from where, at what floor.
 */
export function qualityVerdict(
  answers: QualityAnswers | null,
  work: TurnWork,
  settings: CutJudgeSettings,
): QualityVerdict | null {
  // Fails open: a judgment that could not be asked never holds a turn back.
  if (!answers || !settings.qualityGate) return null;

  const doubted =
    answers.finished.noul < settings.qualityFinished ||
    answers.seen.noul < settings.qualitySeen ||
    answers.honest.noul < settings.qualityHonest;
  if (!doubted) return null;

  // A doubt alone is not enough to spend another round on. The hold has to
  // point at something the record measures — source seconds nobody looked at,
  // or calls that did not land — because the editor cannot prove a build
  // unfinished, and a finished turn sent back does its work a second time.
  const source = thinnest(work.sources);
  if (source) {
    const interval = intervalFor(answers.closeness.choice);
    const unnoted = source.unnoted
      .slice(0, 3)
      .map((g) => `${round2(g.from)}-${round2(g.to)}s`)
      .join(", ");
    return {
      step: "watch",
      steer:
        `${QUALITY_STEER_PREFIX} Not yet. You have seen "${source.name}" through ${round2(source.coveredTo)}s of ${round2(source.duration)}s, ` +
        `and ${round2(source.unwatched)}s of it has never been looked at. Keep watching before you answer: ` +
        `watch_video from=${round2(source.coveredTo)} interval_seconds=${interval}, note_source what it showed, and go again until nothing is left unseen.` +
        (unnoted ? ` Still undescribed: ${unnoted}.` : "") +
        standing(work),
    };
  }
  if (work.failed.length > 0) {
    return {
      step: "repair",
      steer:
        `${QUALITY_STEER_PREFIX} Not yet. These calls failed: ${work.failed.join(", ")}. ` +
        "Land them with tools now — then reply with what the cut actually is." +
        standing(work),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Harvesting the record off the turn's own tool results, the way the mutation
// ledger harvests ids: the gate judges what the calls actually returned, not
// what the model said about them.

const isRec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const numOf = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

function spansOf(v: unknown): { from: number; to: number }[] {
  return Array.isArray(v)
    ? v.filter(isRec).map((g) => ({ from: numOf(g.from), to: numOf(g.to) }))
    : [];
}

function notesOf(v: unknown): { from: number; to: number; text: string }[] {
  return Array.isArray(v)
    ? v
        .filter(isRec)
        .map((n) => ({
          from: numOf(n.from),
          to: numOf(n.to),
          text: typeof n.text === "string" ? n.text : "",
        }))
        .filter((n) => n.text)
    : [];
}

/** Fold one look's result into the turn's record of what it has seen.
 * Anything that is not a look, or whose result carries no source, is
 * ignored. */
export function recordLook(
  sources: Map<string, WatchedSource>,
  tool: string,
  response: unknown,
): void {
  if (tool !== "watch_video" && tool !== "note_source") return;
  if (!isRec(response)) return;
  const src = isRec(response.source) ? response.source : null;
  const id = src && typeof src.assetId === "string" ? src.assetId : null;
  if (!src || !id) return;
  const cur: WatchedSource = sources.get(id) ?? {
    name: typeof src.name === "string" ? src.name : "this source",
    duration: numOf(src.duration),
    passes: 0,
    coveredTo: 0,
    unwatched: numOf(src.duration),
    unnoted: [],
    observed: [],
    cuts: 0,
  };
  if (tool === "watch_video") {
    cur.passes++;
    cur.coveredTo = Math.max(cur.coveredTo, numOf(response.coveredTo, cur.coveredTo));
    cur.unwatched = numOf(response.unwatchedSeconds, cur.unwatched);
    cur.cuts += Array.isArray(response.sceneChanges) ? response.sceneChanges.length : 0;
    const recorded = notesOf(response.recorded);
    // `recorded` is what was already written about the span just watched;
    // note_source's own result carries the whole record and wins over it.
    if (recorded.length > cur.observed.length) cur.observed = recorded;
  } else {
    cur.observed = notesOf(response.notes);
  }
  cur.unnoted = spansOf(response.unnoted);
  sources.set(id, cur);
}
