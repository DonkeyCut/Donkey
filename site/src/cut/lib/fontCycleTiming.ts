// A font cycle timed to switch points: the beats of a music clip, or times
// read off a reference. The assistant's set_overlay_animation and the
// Inspector's Font cycle panel both time a cycle through here, so a cycle
// timed either way holds each face the same.

import {
  CYCLE_HOLD_MAX,
  CYCLE_HOLD_MIN,
  FONT_CYCLE_FACES_MAX,
  retimeOf,
  type CycleFace,
  type OverlayFontCycle,
} from "@donkeycut/effects-kit";
import type { AudioClip, MediaAsset, VideoClip } from "./types";

/** Beat steps the panel offers: half beats, every beat, every other, every fourth. */
export const CYCLE_BEAT_STEPS = [0.5, 1, 2, 4] as const;

/** The beats a clip plays, on the timeline's clock, in play order. Empty
 * when the clip's asset has no beat grid yet. */
export function clipBeatTimes(clip: VideoClip | AudioClip, asset: MediaAsset | undefined): number[] {
  const grid = asset?.beats?.beats ?? [];
  const retime = retimeOf(clip);
  return grid
    .filter((b) => b >= clip.in && b <= clip.out)
    .map((b) => clip.start + retime.tAt(b))
    .sort((a, b) => a - b);
}

/** Whether a beat step is whole beats (1, 2, 4) or an even split of one
 * (0.5, 0.25). */
export function validBeatStep(step: number): boolean {
  if (!(step > 0)) return false;
  return step >= 1 ? Math.abs(Math.round(step) - step) <= 1e-3 : Math.abs(1 / Math.round(1 / step) - step) <= 1e-3;
}

/** Face changes on a beat grid, seconds on the same clock as `beats`: every
 * `step`th beat from the first one at or after `from`, or each beat split
 * into 1/step parts, inside [from, to), closed by the run's end or one
 * spacing past the last beat. Empty when no beat lands inside the run. */
export function beatSwitches(beats: number[], step: number, from: number, to: number): number[] {
  const whole = step >= 1 ? Math.round(step) : 1;
  const parts = step < 1 ? Math.round(1 / step) : 1;
  const first = beats.findIndex((t) => t >= from - 1e-6);
  const picked = (first < 0 ? [] : beats.slice(first)).filter((_, i) => i % whole === 0);
  const points = picked.flatMap((b, i) =>
    i + 1 < picked.length ? Array.from({ length: parts }, (_, k) => b + ((picked[i + 1] - b) * k) / parts) : [b]
  );
  const inside = points.filter((t) => t >= from - 1e-6 && t < to - 1e-6);
  if (inside.length === 0) return [];
  const after = points.find((t) => t >= to - 1e-6);
  const spacing = inside.length > 1 ? (inside[inside.length - 1] - inside[0]) / (inside.length - 1) : to - inside[0];
  const close = after !== undefined ? to : Math.min(to, inside[inside.length - 1] + spacing);
  return [...inside, close];
}

/** Switch times, seconds from the element's start, kept inside the element,
 * in order, with a switch under a face's shortest hold after the one before
 * it merged into it (the run's end is kept). */
export function tidySwitches(edges: number[], dur: number): number[] {
  const sorted = edges
    .filter((t) => t >= -1e-6 && t <= dur + 1e-6)
    .map((t) => Math.round(Math.max(0, Math.min(dur, t)) * 1e6) / 1e6)
    .sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of sorted) {
    if (out.length > 0 && t - out[out.length - 1] < CYCLE_HOLD_MIN) {
      if (t === sorted[sorted.length - 1] && out.length > 1) out[out.length - 1] = t;
      continue;
    }
    out.push(t);
  }
  return out;
}

/** What keeps tidy switch times from timing a cycle: too few to hold one
 * face, more faces than a cycle holds, or a gap longer than a face's longest
 * hold (with that gap). Null when they time one. */
export type SwitchProblem = { kind: "few" } | { kind: "many"; faces: number } | { kind: "long"; seconds: number };

export function switchProblem(edges: number[]): SwitchProblem | null {
  if (edges.length < 2) return { kind: "few" };
  if (edges.length - 1 > FONT_CYCLE_FACES_MAX) return { kind: "many", faces: edges.length - 1 };
  const longest = Math.max(...edges.slice(1).map((t, i) => t - edges[i]));
  if (longest > CYCLE_HOLD_MAX) return { kind: "long", seconds: longest };
  return null;
}

/** The cycle that shows one face per switch gap, the faces repeating in
 * order to fill the gaps. `round` puts a time on the grid the caller keeps.
 * Example: faces [a, b] over switches 0.5, 1, 2 → a at 0.5 for 0.5s, then b
 * for 1s, and the title's own face after 2. */
export function timedFontCycle(
  faces: CycleFace[],
  edges: number[],
  rate: number,
  round: (t: number) => number = (t) => t
): OverlayFontCycle {
  const timed = edges.slice(1).map((end, i) => ({ ...faces[i % faces.length], hold: round(end - edges[i]) }));
  return { faces: timed, at: round(edges[0]), seconds: round(edges[edges.length - 1] - edges[0]), rate };
}
