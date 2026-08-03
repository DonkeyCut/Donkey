/**
 * Overlay animation: preset In / Out / Loop slots evaluated by one pure
 * function. The DOM preview applies the result as a per-frame CSS transform;
 * the export samples the same function into rasterized frames — a single
 * evaluator is what keeps the two in lockstep.
 */

export type OverlayAnimStyle =
  | "fade"
  | "pop"
  | "zoom"
  | "slideleft"
  | "slideright"
  | "slideup"
  | "slidedown"
  | "typewriter"; // text only; other kinds render it as a fade

export type OverlayLoopStyle = "pulse" | "wiggle" | "spin" | "float";

export interface OverlayAnim {
  in?: { style: OverlayAnimStyle; seconds: number };
  out?: { style: OverlayAnimStyle; seconds: number };
  /** Runs the element's whole duration; `speed` multiplies the base rate
   * (1 = default, 2 = twice as fast). */
  loop?: { style: OverlayLoopStyle; speed: number };
}

export const OVERLAY_ANIM_STYLE_IDS: OverlayAnimStyle[] = [
  "fade",
  "pop",
  "zoom",
  "slideleft",
  "slideright",
  "slideup",
  "slidedown",
  "typewriter",
];

export const OVERLAY_LOOP_STYLE_IDS: OverlayLoopStyle[] = ["pulse", "wiggle", "spin", "float"];

export const OVERLAY_ANIM_STYLE_LABELS: Record<OverlayAnimStyle, string> = {
  fade: "Fade",
  pop: "Pop",
  zoom: "Zoom",
  slideleft: "Slide left",
  slideright: "Slide right",
  slideup: "Slide up",
  slidedown: "Slide down",
  typewriter: "Typewriter",
};

export const OVERLAY_LOOP_STYLE_LABELS: Record<OverlayLoopStyle, string> = {
  pulse: "Pulse",
  wiggle: "Wiggle",
  spin: "Spin",
  float: "Float",
};

/** Ramp length bounds, seconds (mirrors clip animations). */
export const OVERLAY_ANIM_MIN_SECONDS = 0.1;
export const OVERLAY_ANIM_MAX_SECONDS = 2;
export const OVERLAY_ANIM_DEFAULT_SECONDS = 0.5;

/** How far slides travel, in design px at the 1080 short side. */
export const SLIDE_TRAVEL = 120;
/** Float bob amplitude, design px. */
export const FLOAT_TRAVEL = 12;
/** Base loop periods in seconds at speed 1. */
export const LOOP_PERIODS: Record<OverlayLoopStyle, number> = {
  pulse: 1.2,
  wiggle: 0.9,
  spin: 4,
  float: 2.4,
};

/** The transform an animation contributes at one moment. dx/dy are design px
 * (1080 short side); rotate is degrees; alpha multiplies the element opacity;
 * textProgress (0..1, typewriter only) is the share of characters shown. */
export interface OverlayAnimState {
  dx: number;
  dy: number;
  scale: number;
  rotate: number;
  alpha: number;
  textProgress?: number;
}

const IDLE: OverlayAnimState = { dx: 0, dy: 0, scale: 1, rotate: 0, alpha: 1 };

const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3);
const easeInCubic = (p: number) => p * p * p;
const easeOutBack = (p: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
};

/** One edge ramp. `p` runs 0→1 over the window in play direction for "in";
 * for "out" the caller feeds remaining-share so the motion mirrors. */
function edgeState(style: OverlayAnimStyle, p: number, exiting: boolean): OverlayAnimState {
  const clamped = Math.min(1, Math.max(0, p));
  switch (style) {
    case "fade":
      return { ...IDLE, alpha: clamped };
    case "pop":
      // Entering overshoots then settles; exiting shrinks away without the
      // overshoot (a reverse overshoot reads as a stutter).
      return {
        ...IDLE,
        scale: exiting ? easeInCubic(clamped) * 0.4 + 0.6 * clamped : easeOutBack(clamped),
        alpha: Math.min(1, clamped * 2),
      };
    case "zoom":
      return { ...IDLE, scale: 0.6 + 0.4 * easeOutCubic(clamped), alpha: clamped };
    case "slideleft":
      // The picture moves leftward: it enters from the right edge, or exits
      // off the left one — the exit's offset runs negative.
      return { ...IDLE, dx: (1 - easeOutCubic(clamped)) * SLIDE_TRAVEL * (exiting ? -1 : 1), alpha: clamped };
    case "slideright":
      return { ...IDLE, dx: (1 - easeOutCubic(clamped)) * SLIDE_TRAVEL * (exiting ? 1 : -1), alpha: clamped };
    case "slideup":
      return { ...IDLE, dy: (1 - easeOutCubic(clamped)) * SLIDE_TRAVEL * (exiting ? -1 : 1), alpha: clamped };
    case "slidedown":
      return { ...IDLE, dy: (1 - easeOutCubic(clamped)) * SLIDE_TRAVEL * (exiting ? 1 : -1), alpha: clamped };
    case "typewriter":
      return { ...IDLE, textProgress: clamped };
  }
}

/**
 * Evaluate an element's animation at `tLocal` seconds into its [0, dur]
 * window. Pure and deterministic — the preview, the export frame renderer,
 * and the browser compositor all call this same function.
 */
export function evalOverlayAnim(
  anim: OverlayAnim | undefined,
  tLocal: number,
  dur: number
): OverlayAnimState {
  if (!anim) return IDLE;
  let state = { ...IDLE };

  const inSecs = anim.in ? Math.min(anim.in.seconds, dur) : 0;
  const outSecs = anim.out ? Math.min(anim.out.seconds, Math.max(0, dur - inSecs)) : 0;

  if (anim.in && tLocal < inSecs) {
    state = edgeState(anim.in.style, tLocal / inSecs, false);
  } else if (anim.out && tLocal > dur - outSecs) {
    state = edgeState(anim.out.style, (dur - tLocal) / outSecs, true);
  }

  if (anim.loop) {
    const speed = anim.loop.speed > 0 ? anim.loop.speed : 1;
    const period = LOOP_PERIODS[anim.loop.style] / speed;
    const phase = (tLocal % period) / period;
    const wave = Math.sin(phase * Math.PI * 2);
    switch (anim.loop.style) {
      case "pulse":
        state.scale *= 1 + 0.06 * wave;
        break;
      case "wiggle":
        state.rotate += 4 * wave;
        break;
      case "spin":
        state.rotate += phase * 360;
        break;
      case "float":
        state.dy += FLOAT_TRAVEL * wave;
        break;
    }
  }
  return state;
}

/** The loop's exact cycle length in seconds (frame sequences render one cycle
 * and repeat it), or null when the element has no loop. */
export function loopPeriod(anim: OverlayAnim | undefined): number | null {
  if (!anim?.loop) return null;
  const speed = anim.loop.speed > 0 ? anim.loop.speed : 1;
  return LOOP_PERIODS[anim.loop.style] / speed;
}

/** Whether any slot is set (an element with an empty anim object is static). */
export function hasOverlayAnim(anim: OverlayAnim | undefined): boolean {
  return !!anim && (!!anim.in || !!anim.out || !!anim.loop);
}
