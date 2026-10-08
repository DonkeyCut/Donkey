/**
 * The font flicker: a title that cycles through typefaces for a stretch of
 * its life, a new face every step, then settles back into its own. Each face
 * can carry its own weight, size and tracking, because a face shown for a
 * frame or two has to fill the same room the title's own face does.
 *
 * It is a slot on the element's animation and changes the type itself, so
 * every painter reads the element through `withFontCycle` at the moment it
 * draws, and every sampler cuts its pictures at `fontCycleCuts`.
 */

import type { Overlay, TextOverlay } from "./types";

/** One face in the cycle. Absent fields keep the title's own. */
export interface CycleFace {
  font: string;
  weight?: TextOverlay["weight"];
  /** Type-size multiplier on the title's own size. */
  scale?: number;
  /** Letter spacing, em; absent = the title's own. */
  tracking?: number;
}

/** The cycle: `faces` in order, `rate` changes a second, running from `at`
 * seconds into the element for `seconds`. */
export interface OverlayFontCycle {
  faces: CycleFace[];
  at: number;
  seconds: number;
  rate: number;
}

/** Face changes a second the cycle runs at unless it names its own: one every
 * other frame at 30 fps. */
export const FONT_CYCLE_RATE = 15;
export const FONT_CYCLE_RATE_MIN = 2;
export const FONT_CYCLE_RATE_MAX = 30;
/** The most faces one cycle walks. */
export const FONT_CYCLE_FACES_MAX = 12;
/** Face scale bounds. */
export const CYCLE_SCALE_MIN = 0.5;
export const CYCLE_SCALE_MAX = 4;

/** Slack on a step's edges, well under a frame: a frame time on an edge
 * belongs to the step it opens in every renderer. */
const STEP_SLACK = 1e-4;

const rateOf = (c: OverlayFontCycle) =>
  Math.max(FONT_CYCLE_RATE_MIN, Math.min(FONT_CYCLE_RATE_MAX, c.rate > 0 ? c.rate : FONT_CYCLE_RATE));

/** The cycle a text element carries, or nothing — other kinds have no face. */
export function overlayFontCycle(o: Overlay): OverlayFontCycle | undefined {
  if ((o.kind ?? "text") !== "text") return undefined;
  const c = o.anim?.fonts;
  return c && c.faces.length > 0 && c.seconds > 0 ? c : undefined;
}

/** The face showing `tLocal` seconds into the element, or null outside the
 * cycle's run. */
export function cycleFaceAt(c: OverlayFontCycle, tLocal: number): CycleFace | null {
  const u = tLocal - c.at;
  if (u < -STEP_SLACK || u >= c.seconds - STEP_SLACK) return null;
  const step = Math.max(0, Math.floor((u + STEP_SLACK) * rateOf(c)));
  return c.faces[step % c.faces.length];
}

/** The element as it is set `tLocal` seconds in: the cycle's face while it
 * runs, its own outside it. Hands back the same object when nothing changes,
 * so a caller can memoize on identity. The face it hands back carries no
 * cycle, so resolving it again changes nothing. */
export function withFontCycle<T extends Overlay>(o: T, tLocal: number): T {
  const c = overlayFontCycle(o);
  if (!c) return o;
  const face = cycleFaceAt(c, tLocal);
  if (!face) return o;
  const t = o as TextOverlay;
  const scale = Math.max(CYCLE_SCALE_MIN, Math.min(CYCLE_SCALE_MAX, face.scale ?? 1));
  return {
    ...o,
    font: face.font,
    weight: face.weight ?? t.weight,
    size: t.size * scale,
    letterSpacing: face.tracking ?? t.letterSpacing,
    anim: { ...o.anim, fonts: undefined },
  } as T;
}

/** Seconds from the element's start where its face changes, inside (0, dur):
 * the edges of every step, and the cycle's own start and end. A sampler cuts
 * its pictures here. */
export function fontCycleCuts(o: Overlay, dur: number): number[] {
  const c = overlayFontCycle(o);
  if (!c) return [];
  const rate = rateOf(c);
  const end = Math.min(dur, c.at + c.seconds);
  const cuts: number[] = [];
  for (let i = 0; ; i++) {
    const t = c.at + i / rate;
    if (t >= end - 1e-3) break;
    if (t > 1e-3) cuts.push(Math.round(t * 1e4) / 1e4);
  }
  if (end > 1e-3 && end < dur - 1e-3) cuts.push(Math.round(end * 1e4) / 1e4);
  return cuts;
}

/** `spans` (a partition of [0, dur]) cut again at every face change, each
 * piece the span it came from. */
export function cutAtFaces<S extends { start: number; end: number }>(spans: S[], cuts: number[]): S[] {
  if (cuts.length === 0) return spans;
  const out: S[] = [];
  for (const s of spans) {
    let a = s.start;
    for (const c of cuts) {
      if (c <= a + 1e-3 || c >= s.end - 1e-3) continue;
      out.push({ ...s, start: a, end: c });
      a = c;
    }
    out.push({ ...s, start: a, end: s.end });
  }
  return out;
}

/** The element once in each face of its cycle — what a sampler measures so
 * its crop holds the widest face as well as the title's own. */
export function fontCycleVariants<T extends Overlay>(o: T): T[] {
  const c = overlayFontCycle(o);
  if (!c) return [];
  return c.faces.map((_, i) => withFontCycle(o, c.at + (i + 0.5) / rateOf(c)));
}

/** A tag naming the face showing at `tLocal`, for a sampler that caches
 * pictures by what they show; "" in the title's own face. */
export function cycleFaceTag(o: Overlay, tLocal: number): string {
  const c = overlayFontCycle(o);
  const face = c ? cycleFaceAt(c, tLocal) : null;
  return face ? `|face${c!.faces.indexOf(face)}` : "";
}
