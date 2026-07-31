// True up speech-cut edges against the silence around them.
//
// The assistant plans cuts from cue timings and silence spans, but the numbers
// it emits are hand-derived floats: an edge lands a hair inside a word, or
// leaves stray dead air. The split of labor is the usual one — the model says
// WHICH edges are speech cuts, and the arithmetic here decides exactly where
// each one sits: a breath inside the real pause.
//
// The rules err toward keeping words. An edge already inside a pause slides to
// a breath past the speech it closes (an out point) or ahead of the speech it
// opens (an in point). An edge sitting in speech — a clipped word — only moves
// outward, to the first pause in the direction that makes the word whole
// again. With no pause within reach the speech runs continuously there, so the
// edge stays where the model put it and comes back flagged for a listen.

/** A silent stretch of the source, in source seconds. */
export interface SilenceSpan {
  start: number;
  end: number;
}

/** The pause kept on the speech side of a refined edge, seconds. */
export const BREATH = 0.25;

/** How far an edge may travel to find or settle into a pause. Beyond this a
 * long pause reads as a held beat — a choice, not slack — and a cut in speech
 * reads as deliberate. */
export const REACH = 2;

/** Which side of the clip an edge trims: "in" opens the clip, "out" closes it. */
export type EdgeKind = "in" | "out";

export interface RefinedEdge {
  /** The refined source time — the input `t` when no pause was within reach. */
  t: number;
  /** False when speech runs continuously at this edge and it was left alone. */
  pause: boolean;
}

const EPS = 1e-3;
const round = (n: number) => Math.round(n * 1000) / 1000;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Place one trim edge a breath inside the pause it belongs to. `spans` are the
 * silences detected around `t`, sorted by start and disjoint.
 */
export function refineEdge(
  spans: readonly SilenceSpan[],
  t: number,
  kind: EdgeKind
): RefinedEdge {
  const within = spans.find((s) => t >= s.start - EPS && t <= s.end + EPS);
  if (within) {
    // A pause shorter than two breaths still holds a cut — the edge settles at
    // the pause's far boundary and the whole pause is the breath.
    const ideal =
      kind === "out"
        ? Math.min(within.end, within.start + BREATH)
        : Math.max(within.start, within.end - BREATH);
    return { t: round(clamp(ideal, t - REACH, t + REACH)), pause: true };
  }
  if (kind === "out") {
    const next = spans.find((s) => s.start > t && s.start - t <= REACH);
    if (next) return { t: round(Math.min(next.end, next.start + BREATH)), pause: true };
  } else {
    let prev: SilenceSpan | undefined;
    for (const s of spans) {
      if (s.end < t && t - s.end <= REACH) prev = s;
      if (s.end >= t) break;
    }
    if (prev) return { t: round(Math.max(prev.start, prev.end - BREATH)), pause: true };
  }
  return { t, pause: false };
}
