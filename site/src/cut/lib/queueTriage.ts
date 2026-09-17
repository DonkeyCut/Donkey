import { choice, noul, type ChoiceAnswer, type Entry, type NoulAnswer } from "./judge";

// Where a message sent mid-turn goes. One typed judgment reads the running
// ask, what it has done so far, and each message, and names one of three
// places: fold (the running turn takes it in stride), spawn (a second thread
// runs it in parallel because the work cannot collide), or queue (it waits in
// the tray for the finished result). The page acts deterministically on the
// verdict, and a failed call reads as queue — the tray is the safe place, and
// it is exactly what the queue did before triage existed.

export type QueueVerdict = "fold" | "queue" | "spawn";

export interface TriageAnchor {
  /** The ask the running turn is working on. */
  ask: string;
  /** Tools the turn has run so far, in order, "name" or "name (running)". */
  progress: string[];
  /** Asks running in other threads of the same project right now. */
  elsewhere: string[];
}

export interface TriageRow {
  id: string;
  text: string;
}

const TEXT_CAP = 2000;

/** The judge's state: the running work and the rows to place, each under
 * the short id its verdict is keyed by. */
export function queueTriageState(anchor: TriageAnchor, waiting: TriageRow[], rows: TriageRow[]): Entry {
  const clip = (s: string) => s.slice(0, TEXT_CAP);
  return {
    running: {
      ask: clip(anchor.ask),
      toolsRunSoFar: anchor.progress,
      inOtherChats: anchor.elsewhere.map(clip),
    },
    alreadyWaiting: waiting.map((r) => clip(r.text)),
    messages: rows.map((r) => ({ id: r.id, text: clip(r.text) })),
  };
}

const PLACE_CRITERIA = {
  fold: "The working agent takes it in the same pass: the message refines, extends, narrows, corrects, or adds to the running ask (\"also…\", \"and make it…\", \"actually…\", \"not that one\", \"bigger\"), asks about the work in progress, or is another question when the running ask is a question. A further edit to the same items, the same job, or the same stretch of the timeline folds too.",
  spawn:
    "A second agent runs it in parallel right now, because it is a different job on things nothing running touches: a question about the footage, a source, or the project that changes nothing; or an edit to other items than the running work's (the look, color, or volume of a different clip, a caption style, the music level, a project setting) whose timing the running work cannot move and that does not need its result. Being in the same video is no collision; the same items or the same job is.",
  queue:
    "It waits for the running ask to finish and for a fresh view of the project: it needs the finished result (export, render, share, publish, a thumbnail or summary of the final cut), or it is sequenced after the running work (\"then…\", \"after that…\", \"once it's done…\"). Anything unclear.",
} as const;

/** One placement and one collision question per row. */
export function queueTriageQuestions(rows: TriageRow[]) {
  const out: Record<string, ReturnType<typeof choice<typeof PLACE_CRITERIA>> | ReturnType<typeof noul>> = {};
  for (const r of rows) {
    out[`place::${r.id}`] = choice(
      `The user sent \`messages\` (id "${r.id}") to the AI editor built into a video editor while it was already working on \`running.ask\`; \`running.toolsRunSoFar\` is what that work has done, \`running.inOtherChats\` lists asks running in other chats of the same project, and \`alreadyWaiting\` the messages queued before it. Where does message "${r.id}" go?`,
      PLACE_CRITERIA,
    );
    out[`collides::${r.id}`] = noul(
      `Does message "${r.id}" place or time something on the timeline (a sticker at 12 seconds, a title at the end, a sound effect on a moment) while running work in this chat or another cuts, trims, moves, splits, deletes, or reorders clips, so the times it names would shift under it?`,
    );
  }
  return out;
}

export type QueueTriageAnswers = Record<string, ChoiceAnswer<typeof PLACE_CRITERIA> | NoulAnswer>;

/** The probability a placement needs before the code commits to it; below
 * it the row waits. The chosen option's own probability is the measure, since
 * a clear pick over two also-rans reads as low concentration. */
const PLACE_FLOOR = 0.5;
const COLLISION_FLOOR = 0.5;

/** Each row's place, composed from the answers: a collision forbids a spawn,
 * an uncertain placement queues, and a row with no answer queues. */
export function placeQueuedRows(answers: QueueTriageAnswers | null, rows: TriageRow[]): Map<string, QueueVerdict> {
  const out = new Map<string, QueueVerdict>(rows.map((r) => [r.id, "queue"]));
  if (!answers) return out;
  for (const r of rows) {
    const place = answers[`place::${r.id}`];
    if (!place || place.type !== "choice") continue;
    const collides = answers[`collides::${r.id}`];
    const collision = collides?.type === "noul" ? collides.noul : 0;
    if ((place.probabilities[place.choice] ?? 0) < PLACE_FLOOR) continue;
    if (place.choice === "spawn" && collision >= COLLISION_FLOOR) continue;
    if (place.choice === "fold" || place.choice === "spawn" || place.choice === "queue") out.set(r.id, place.choice);
  }
  return out;
}

/** The running turn's progress, read off the streaming assistant message's
 * parts: each tool it has called, finished ones by name and open ones marked. */
export function toolProgress(
  parts: readonly { type: string; state?: string; toolName?: string }[]
): string[] {
  return parts.flatMap((p) => {
    const name =
      p.type === "dynamic-tool"
        ? p.toolName
        : p.type.startsWith("tool-")
          ? p.type.slice(5)
          : undefined;
    if (!name) return [];
    return [p.state === "output-available" || p.state === "output-error" ? name : `${name} (running)`];
  });
}
