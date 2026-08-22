// Place a speech cut against the words around it.
//
// The assistant plans cuts from cue timings and what it heard, but the numbers
// it emits are hand-derived floats: an edge lands a hair inside a word, or
// leaves stray dead air. The split of labor is the usual one — the model says
// WHICH edges are speech cuts, and the arithmetic here decides exactly where
// each one sits.
//
// What makes a joint pleasant is air, and the amount is small and specific: a
// beat after the last word finishes decaying, a shorter one before the next
// one starts. Both are measured from the word, never from the edge the model
// guessed, so a cut cannot land inside a word and cannot butt two words
// together. Pace changes how much air, never whether there is any — the
// fastest cut in this file still lets every word finish.

import type { SpeechSegment } from "./audioScan";

export type { SpeechSegment };

/** How much room the cut leaves around the words. */
export type Pace = "fast" | "natural" | "relaxed";

/** Air kept after the last word ("out") and before the next one ("in"),
 * seconds. Out runs longer than in: the ear wants a word to land before the
 * picture moves on, and it takes the next word's own attack as the lead. */
export const AIR: Record<Pace, { out: number; in: number }> = {
  fast: { out: 0.14, in: 0.09 },
  natural: { out: 0.26, in: 0.16 },
  relaxed: { out: 0.45, in: 0.28 },
};

/** The air no pace goes under. Under this the cut is heard as clipping the
 * word even when the waveform says it did not. */
export const MIN_AIR = { out: 0.08, in: 0.06 };

/** Kept clear of the neighbouring word when the pause cannot hold the air. */
const GUARD = 0.02;

/** How far an edge may travel to reach a word boundary. Beyond this a long
 * pause reads as a held beat — a choice, not slack — and a cut inside a long
 * run of speech reads as deliberate. */
export const REACH = 2;

/** Which side of the clip an edge trims: "in" opens the clip, "out" closes it. */
export type EdgeKind = "in" | "out";

export interface PlacedEdge {
  /** The placed source time — the input `t` when no word was within reach. */
  t: number;
  /** False when the scan found no word to place against and the edge was left
   * where the model put it. */
  placed: boolean;
  /** The word boundary this edge protects: the latest an out edge may sit
   * before it, the earliest an in edge may sit after it. Repairing a joint
   * works from these, so the repair cannot clip a word either. */
  bound: number;
}

const EPS = 1e-3;
const round = (n: number) => Math.round(n * 1000) / 1000;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Place one trim edge against the speech around it. `segments` are the words
 * the scan found, in order and disjoint; `bounds` is the span it looked at, so
 * an edge with open air on one side does not wander past what was measured.
 *
 * An out edge follows the word it keeps: past that word's tail by the pace's
 * air, and never into the word after it. An in edge leads the word it opens by
 * the same reasoning. An edge sitting inside a word moves outward, which is
 * what makes the word whole again.
 */
export function placeEdge(
  segments: readonly SpeechSegment[],
  t: number,
  kind: EdgeKind,
  pace: Pace = "natural",
  bounds?: { from: number; to: number }
): PlacedEdge {
  const air = AIR[pace];
  const unplaced: PlacedEdge = { t, placed: false, bound: t };

  if (kind === "out") {
    // The word this clip keeps: the last one that has started by `t`. An edge
    // inside it extends to its end; an edge past it pulls back to the same
    // place, so both cases are the one rule.
    let keep: SpeechSegment | undefined;
    for (const s of segments) {
      if (s.start - EPS > t) break;
      keep = s;
    }
    if (!keep || Math.abs(keep.end - t) > REACH) return unplaced;
    const next = segments.find((s) => s.start > keep!.end + EPS);
    const ceiling = Math.min(next ? next.start - GUARD : Infinity, bounds?.to ?? Infinity);
    return {
      t: round(clamp(keep.end + air.out, keep.end, Math.max(keep.end, ceiling))),
      placed: true,
      bound: round(keep.end),
    };
  }

  // The word this clip opens on: the first one still sounding at `t`.
  const word = segments.find((s) => s.end - EPS > t);
  if (!word || Math.abs(word.start - t) > REACH) return unplaced;
  let prev: SpeechSegment | undefined;
  for (const s of segments) {
    if (s.end - EPS > word.start) break;
    prev = s;
  }
  const floorT = Math.max(prev ? prev.end + GUARD : -Infinity, bounds?.from ?? -Infinity);
  return {
    t: round(clamp(word.start - air.in, Math.min(word.start, floorT), word.start)),
    placed: true,
    bound: round(word.start),
  };
}

/**
 * Where two edges of one removed stretch land when the pace would push them
 * past each other — the pause left between the words is shorter than the air
 * both sides want.
 *
 * Both sides give ground rather than either reverting to the model's guess:
 * the joint sits at one point inside the pause, as close to the middle as the
 * two words allow. Returns null when the words themselves overlap, which means
 * the stretch being removed is not a pause at all.
 */
export function settleJoint(out: PlacedEdge, into: PlacedEdge): number | null {
  const lo = out.bound;
  const hi = into.bound;
  if (hi - lo < EPS) return null;
  const wanted = (out.t + into.t) / 2;
  const room = hi - lo;
  // Split what there is: the out side takes the larger share, the same way it
  // takes the longer air when there is room for both.
  const lowest = lo + Math.min(MIN_AIR.out, room * 0.6);
  const highest = hi - Math.min(MIN_AIR.in, room * 0.4);
  return round(clamp(wanted, Math.min(lowest, highest), Math.max(lowest, highest)));
}
