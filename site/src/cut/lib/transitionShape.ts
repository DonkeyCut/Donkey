/**
 * The geometry of the shaped transitions, written once for both renderers:
 * the compositor draws it on a canvas (preview and the tab's export) and
 * the ffmpeg export spells the same numbers as an xfade expression. Keeping
 * the curves and constants here is what keeps the two in step.
 */

import type { TransitionStyle } from "./types";

/** The styles whose reveal edge can be softened, and the axis it runs on. */
export const FEATHER_STYLES: TransitionStyle[] = [
  "wipeleft",
  "wiperight",
  "wipeup",
  "wipedown",
  "circleopen",
  "circleclose",
  "splitopen",
  "splitclose",
];

/** The softest edge offered: a ramp half the frame wide. */
export const TRANSITION_FEATHER_MAX = 0.5;

/** The styles that cut the frame into two halves sliding opposite ways. */
export const SLICE_STYLES: TransitionStyle[] = ["sliceleft", "sliceup"];

/**
 * How long the virtual shutter stays open on a sliding half, seconds: half a
 * frame at 30fps, the 180° shutter a camera would have smeared the move
 * with. The halves streak by however far they travel in that time.
 */
export const SLICE_SHUTTER = 1 / 60;

/** How many copies average into a sliding half's streak. */
export const SLICE_TAPS = 5;

/** The clock wipe's sweep from the top edge down to the left one. */
export const CLOCK_SWEEP = Math.PI / 2;

/** Whether `style` takes a soft edge. */
export const takesFeather = (style: TransitionStyle | undefined): boolean =>
  !!style && FEATHER_STYLES.includes(style);

/** A clip's stored softness brought into range; 0 = a hard edge. */
export const clampFeather = (v: number | undefined): number =>
  Math.min(TRANSITION_FEATHER_MAX, Math.max(0, Number.isFinite(v) ? (v as number) : 0));

/**
 * The slices' whip, fitted to a reference's slice bars: the halves pull a
 * quarter of their move (`SLICE_KNEE_SHARE`) by `SLICE_KNEE` of the way
 * through, rising as a power `SLICE_PULL` of progress, then snap through the
 * middle and settle onto the frame as a power `SLICE_SETTLE` of what is left.
 */
export const SLICE_KNEE = 0.385;
export const SLICE_KNEE_SHARE = 0.25;
export const SLICE_PULL = 1.75;
export const SLICE_SETTLE = 2.7;

/**
 * The share of its move a shaped transition has made at linear progress `p`.
 * The slices whip (above); the clock wipe leaves fast and settles onto the
 * edge.
 */
export function shapeEase(style: TransitionStyle, p: number): number {
  const q = Math.min(1, Math.max(0, p));
  if (style === "clockwipe") {
    return 1 - (1 - q) * (1 - q);
  }
  if (q < SLICE_KNEE) {
    return SLICE_KNEE_SHARE * (q / SLICE_KNEE) ** SLICE_PULL;
  }
  return 1 - (1 - SLICE_KNEE_SHARE) * ((1 - q) / (1 - SLICE_KNEE)) ** SLICE_SETTLE;
}

/** How fast a slice moves at `p`, in eased share per unit of progress: the
 * slope of its whip. */
export function sliceSpeed(p: number): number {
  const q = Math.min(1, Math.max(0, p));
  if (q < SLICE_KNEE) {
    return ((SLICE_KNEE_SHARE * SLICE_PULL) / SLICE_KNEE) * (q / SLICE_KNEE) ** (SLICE_PULL - 1);
  }
  return (((1 - SLICE_KNEE_SHARE) * SLICE_SETTLE) / (1 - SLICE_KNEE)) * ((1 - q) / (1 - SLICE_KNEE)) ** (SLICE_SETTLE - 1);
}

/**
 * How far a sliding half streaks at `p`, as a share of the axis it slides
 * along, for a transition `seconds` long.
 */
export const sliceStreak = (p: number, seconds: number): number =>
  seconds > 0 ? sliceSpeed(p) * (SLICE_SHUTTER / seconds) : 0;

/** How far a soft edge's ramp runs for `style`, px: the feather is a share
 * of the distance the edge crosses — the width for a sideways wipe or split,
 * the height for an upward or downward one, the half-diagonal for a circle. */
export function featherWidth(style: TransitionStyle, feather: number, W: number, H: number): number {
  const across = style === "wipeup" || style === "wipedown" ? H : style.startsWith("circle") ? Math.hypot(W, H) / 2 : W;
  return clampFeather(feather) * across;
}

/**
 * How much of the incoming shot shows at pixel (x, y) of a W×H frame, 0..1,
 * for a soft-edged reveal at progress `p`. Each style measures a distance
 * from where its edge starts — the far side for a wipe, the center for an
 * opening split or circle — and the reveal reaches `p` of that distance plus
 * the ramp, so the shot is fully hidden at 0 and fully shown at 1.
 */
export function featherAlpha(style: TransitionStyle, p: number, x: number, y: number, W: number, H: number, feather: number): number {
  const F = Math.max(1e-6, featherWidth(style, feather, W, H));
  const ramp = (d: number, span: number, reach: number) => Math.min(1, Math.max(0, (reach * (span + F) - d) / F));
  const R = Math.hypot(W, H) / 2;
  switch (style) {
    case "wipeleft":
      return ramp(W - x, W, p);
    case "wiperight":
      return ramp(x, W, p);
    case "wipeup":
      return ramp(H - y, H, p);
    case "wipedown":
      return ramp(y, H, p);
    case "splitopen":
      return ramp(Math.abs(x - W / 2), W / 2, p);
    case "splitclose":
      return ramp(Math.min(x, W - x), W / 2, p);
    case "circleopen":
      return ramp(Math.hypot(x - W / 2, y - H / 2), R, p);
    case "circleclose":
      return 1 - ramp(Math.hypot(x - W / 2, y - H / 2), R, 1 - p);
    default:
      return p >= 0.5 ? 1 : 0;
  }
}
