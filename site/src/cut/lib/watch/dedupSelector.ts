import {
  diffCellPct,
  frameSig,
  type FrameSig,
  hardCellCount,
  settledCellScores,
} from "./signatures";
import type {
  FrameDecision,
  FrameSelector,
  RgbFrame,
  SelectionResult,
  SelectorOptions,
  Verdict,
} from "./types";

/** The default watch selector: three change detectors vote on each candidate
 * against a sliding window of the last kept frames. The window (rather than
 * only the previous frame) keeps A-B-A alternation out — a shot the model has
 * already seen stays out even when a different frame sat in between.
 *
 *  - global: % of 16-grid cells changed. Sees cuts, pans, motion; blind to
 *    small local changes (each cell averages a whole region away).
 *  - action: a few 32-grid cells changing hard mark a frame as new no matter
 *    the percentage — a small subject can never move 8% of the pixels, so the
 *    one second that matters would otherwise dedup away.
 *  - settled: on a static scene, pixels that differ strongly from every kept
 *    frame in the window (shift-tolerant, so grain and jitter re-match) and
 *    have stopped changing toward the next frame. Sees caption swaps, thin
 *    ink, and local UI updates that measure 0.0% on the global channel. A
 *    cooldown raises its bar after each keep so sustained "settling" motion
 *    can't take a frame every time; a stricter second tolerance must fire in
 *    the same cell so soft-contrast drift (smoke, fades) stays out.
 *
 * Memory holds the window plus a one-frame lookahead, never the whole stream. */

export const DEDUP_TUNING = {
  /** Kept frames each candidate is compared against. */
  WINDOW: 4,
  /** Per-channel value change for a 16-grid cell to count as changed. */
  GLOBAL_TOL: 25,
  /** % of 16-grid cells that must change for a frame to count as new. */
  THRESHOLD: 8,
  /** Action channel: per-channel change for a 32-grid cell to count as hard. */
  ACTION_HARD_TOL: 45,
  /** Action channel: hard cells needed to keep. */
  ACTION_HARD_CELLS: 3,
  /** Settled channel runs only when the global diff vs the previous candidate
   * sits under this (the scene is otherwise static), or on the final frame —
   * a state that appears at the end has nothing after it to prove it settled. */
  SETTLED_STATIC_MAX: 3,
  /** Settled mask tolerance; the strict pass that must fire in the same cell. */
  SETTLED_TOL: 80,
  SETTLED_STRICT_TOL: 105,
  /** Base gate = GATE_FACTOR · THRESHOLD (max-cell %); strict gate = STRICT_FACTOR · base. */
  SETTLED_GATE_FACTOR: 0.85,
  SETTLED_STRICT_FACTOR: 0.4,
  /** Cooldown: each settled keep raises the gate additively; it decays per frame. */
  SETTLED_COOLDOWN_ADD: 2,
  SETTLED_COOLDOWN_DECAY: 0.7,
} as const;

export function createDedupSelector(
  opts: SelectorOptions,
  tuning: Partial<typeof DEDUP_TUNING> = {}
): FrameSelector {
  const T = { ...DEDUP_TUNING, ...tuning };
  const gateBase = T.SETTLED_GATE_FACTOR * T.THRESHOLD;
  const strictGate = T.SETTLED_STRICT_FACTOR * gateBase;

  const window: FrameSig[] = [];
  const decisions: FrameDecision[] = [];
  const keptIdx: number[] = [];
  let pending: FrameSig | null = null;
  let prevG16: Float32Array | null = null; // previous candidate, kept or dropped
  let cooldown = 1;
  let count = 0;
  let finished = false;

  function judge(sig: FrameSig, next: FrameSig | null): void {
    const index = decisions.length;
    let verdict: Verdict = "drop";
    let globalDist = 100;
    let settledScore: number | undefined;
    let settledGate: number | undefined;

    if (window.length === 0) {
      verdict = "first";
    } else {
      globalDist = Math.min(
        ...window.map((k) => diffCellPct(sig.g16, k.g16, T.GLOBAL_TOL))
      );
      if (globalDist > T.THRESHOLD) {
        verdict = "keep-global";
      } else if (
        window.every(
          (k) =>
            diffCellPct(sig.g16, k.g16, T.GLOBAL_TOL) > T.THRESHOLD ||
            hardCellCount(sig.g32, k.g32, T.ACTION_HARD_TOL) >= T.ACTION_HARD_CELLS
        )
      ) {
        verdict = "keep-action";
      } else {
        const motion = prevG16 === null ? 100 : diffCellPct(sig.g16, prevG16, T.GLOBAL_TOL);
        if (motion < T.SETTLED_STATIC_MAX || next === null) {
          const soft = settledCellScores(
            sig.fine,
            window.map((k) => k.fine),
            next?.fine ?? null,
            T.SETTLED_TOL
          );
          settledScore = Math.max(...soft);
          settledGate = gateBase * cooldown;
          if (settledScore > settledGate) {
            // The strict tolerance must fire in the SAME cell — unrelated hard
            // noise elsewhere must not validate a soft drift.
            const hard = settledCellScores(
              sig.fine,
              window.map((k) => k.fine),
              next?.fine ?? null,
              T.SETTLED_STRICT_TOL
            );
            if (soft.some((s, i) => s > settledGate! && hard[i] > strictGate)) {
              verdict = "keep-settled";
              cooldown += T.SETTLED_COOLDOWN_ADD;
            }
          }
        }
      }
    }

    prevG16 = sig.g16;
    cooldown = Math.max(1, cooldown * T.SETTLED_COOLDOWN_DECAY);
    if (verdict !== "drop") {
      keptIdx.push(index);
      window.push(sig);
      if (window.length > T.WINDOW) window.shift();
    }
    const d: FrameDecision = { index, verdict, globalDist, settledScore, settledGate };
    decisions.push(d);
    opts.onDecision?.(d);
  }

  return {
    push(frame: RgbFrame) {
      if (finished) throw new Error("Selector already finished.");
      const sig = frameSig(frame);
      count++;
      if (pending) judge(pending, sig);
      pending = sig;
    },
    finish(): SelectionResult {
      if (!finished) {
        finished = true;
        if (pending) judge(pending, null);
        pending = null;
      }
      let kept = keptIdx;
      if (kept.length > opts.maxFrames) {
        // Thin evenly after the channels have voted, so the survivors stay
        // spread across the range.
        const step = kept.length / opts.maxFrames;
        const keep = new Set<number>();
        for (let i = 0; i < opts.maxFrames; i++) keep.add(Math.floor(i * step));
        kept = kept.filter((idx, pos) => {
          if (keep.has(pos)) return true;
          decisions[idx].verdict = "thinned";
          return false;
        });
      }
      return { kept, decisions, candidateCount: count };
    },
  };
}
