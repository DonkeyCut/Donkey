import { noul, type Entry, type NoulAnswer, type NoulQuestion } from "./judge";

// The sweep primitive: which items a description covers.
//
// "Mute the ones with room tone", "delete the short clips", "put the warm
// look on every interview shot" — the finding used to cost one model round
// per item, because the model had to read the state, decide, call a tool,
// read the result, and go again. Here the deciding is one typed judgment per
// candidate, and every one of them is asked in the same fan-out, so the whole
// find settles in the time of one request. What comes back is a list of ids,
// and the tools that take `ids` apply the change to all of them in one call.

export interface SweepCandidate {
  id: string;
  /** How the item reads to the judge: what it is, when it plays, what it holds. */
  label: string;
}

/** Candidates per request, the size find_filler uses. Chunks go out together
 * and any one of them failing fails the sweep, so this sizes the requests
 * rather than isolating them. */
export const SWEEP_CHUNK = 50;

const key = (i: number) => `s${i}`;

/** One yes/no per candidate: does this item match what was asked for? */
export function sweepQuestions(describe: string, items: SweepCandidate[]): Record<string, NoulQuestion> {
  return Object.fromEntries(
    items.map((c, i) => [
      key(i),
      noul(
        `Item \`${key(i)}\` in \`items\` — is it one of the items the editor described as \`asked_for\`?`,
        {
          true: "This item is one of the ones described.",
          false: "This item is not one of them, or the description says nothing about it.",
        },
      ),
    ]),
  );
}

/** The state one chunk reads: what was asked for, and the items this request
 * judges. Ids stay off the wire — the keys carry the identity back. */
export function sweepState(describe: string, items: SweepCandidate[], keys: string[]): Entry {
  const wanted = new Set(keys);
  return {
    asked_for: describe,
    items: items
      .map((c, i) => ({ key: key(i), is: c.label }))
      .filter((c) => wanted.has(c.key)),
    total: items.length,
  };
}

/** The ids above the floor, in the order the timeline holds them. An item
 * the judgment left unanswered reads as no match. */
export function sweepPicks(
  answers: Record<string, NoulAnswer | undefined> | null,
  items: SweepCandidate[],
  floor: number,
): { id: string; label: string; fit: number }[] {
  if (!answers) return [];
  return items
    .map((c, i) => ({ id: c.id, label: c.label, fit: answers[key(i)]?.noul ?? 0 }))
    .filter((c) => c.fit >= floor);
}
