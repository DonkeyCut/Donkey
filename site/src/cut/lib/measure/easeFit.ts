/** Name the moves in a measured series: where a value holds, where it moves,
 * and which of the editor's eases carries each move from its start value to
 * its end value — so a grow or a slide measured off a reference keys as two
 * set_overlay_keyframes keys with the right curve between them. */

import { easeAt, EASE_IDS, type EaseId } from "@donkeycut/effects-kit";

export interface Move {
  /** Seconds the move starts and lands, on the series' clock. */
  from: number;
  to: number;
  /** The value held before and after. */
  start: number;
  end: number;
  ease: EaseId;
  /** RMS distance of the measured frames from the fitted curve, as a share of
   * the move's size: under 0.03 is the curve; over 0.1 none of them is. */
  error: number;
}

/** Still frames inside one move that do not end it: an ease's slow end moves
 * less than a pixel a frame and reads as a few frames of hold between steps. */
const MERGE_GAP = 4;
/** A move smaller than this many measurement steps is jitter. */
const MIN_STEPS = 3;
/** How far past the frames that visibly moved a move may really start or
 * land, as a share of its visible length: an ease-in's first frames and an
 * ease-out's last ones change by less than a pixel. */
const SLACK = 0.3;
const TIME_STEPS = 16;
/** The share of a step a frame must move by to count as moving: a whole-pixel
 * step does, and a centre swaying half a pixel as both edges grow does not. */
const MOVE_STEP = 0.75;

/** The moves in `values` sampled at `times`, each fitted with its ease. A null
 * value is a frame where the element was not found, and splits the series.
 * `step` is the size of one measurement unit (a pixel, as a fraction): a
 * change under MOVE_STEP of it is no change. */
export function fitMoves(times: number[], values: (number | null)[], step: number): Move[] {
  const moves: Move[] = [];
  let i = 0;
  while (i < values.length) {
    // One unbroken stretch of found frames.
    if (values[i] === null) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < values.length && values[j + 1] !== null) j++;
    moves.push(...movesIn(times.slice(i, j + 1), values.slice(i, j + 1) as number[], step));
    i = j + 1;
  }
  return moves;
}

function movesIn(times: number[], v: number[], step: number): Move[] {
  const moved = (k: number) => Math.abs(v[k] - v[k - 1]) >= step * MOVE_STEP;
  const sign = (k: number) => Math.sign(v[k] - v[k - 1]);
  const moves: Move[] = [];
  let k = 1;
  while (k < v.length) {
    if (!moved(k)) {
      k++;
      continue;
    }

    // Extend the run over short holds that continue the same direction.
    const dir = sign(k);
    const a = k;
    let b = k;
    let m = k + 1;
    while (m < v.length && m - b <= MERGE_GAP + 1) {
      if (moved(m)) {
        if (sign(m) !== dir) break;
        b = m;
      }
      m++;
    }
    k = b + 1;
    const s = a - 1;
    if (Math.abs(v[b] - v[s]) < MIN_STEPS * step) continue;
    moves.push(fitOne(times, v, s, a, b));
  }
  return moves;
}

/** Fit one move: the frames s (last still) … b (last moving) with a the first
 * frame that moved. Searches each ease over start and landing times around
 * the visible ones and keeps the least error. */
function fitOne(times: number[], v: number[], s: number, a: number, b: number): Move {
  const v0 = v[s];
  const v1 = v[b];
  const size = Math.abs(v1 - v0);
  const span = times[b] - times[s];
  const t0Lo = times[s] - SLACK * span;
  const t0Hi = times[a];
  const t1Lo = times[Math.max(a, b - 1)];
  const t1Hi = times[b] + SLACK * span;

  // The frames that judge a fit: everything the search could move a move over.
  const judged: number[] = [];
  for (let k = 0; k < times.length; k++) {
    if (times[k] >= t0Lo - 1e-9 && times[k] <= t1Hi + 1e-9) judged.push(k);
  }

  let best: Move = { from: times[s], to: times[b], start: v0, end: v1, ease: "linear", error: Infinity };
  for (const ease of EASE_IDS) {
    for (let p = 0; p <= TIME_STEPS; p++) {
      const t0 = t0Lo + ((t0Hi - t0Lo) * p) / TIME_STEPS;
      for (let q = 0; q <= TIME_STEPS; q++) {
        const t1 = t1Lo + ((t1Hi - t1Lo) * q) / TIME_STEPS;
        if (t1 - t0 <= 1e-6) continue;
        let sq = 0;
        for (const k of judged) {
          const want = v0 + (v1 - v0) * easeAt(ease, (times[k] - t0) / (t1 - t0));
          sq += (want - v[k]) ** 2;
        }
        const error = Math.sqrt(sq / judged.length) / size;
        // A curve has to beat the simpler one by more than rounding to win.
        if (error < best.error - 1e-4) best = { from: t0, to: t1, start: v0, end: v1, ease, error };
      }
    }
  }
  return best;
}
