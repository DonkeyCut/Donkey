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
  | "typewriter" // text only; other kinds render it as a fade
  | "wipe"
  // Per-glyph styles: on text each character runs the ramp on its own delay
  // (see glyphAnimAt); on every other kind the whole element runs it once.
  | "rise"
  | "drop"
  | "grow"
  | "flip"
  | "swivel"
  | "bounce"
  | "wave"
  | "converge"
  | "streak"
  | "tumble"
  | "scatter";

export type OverlayLoopStyle =
  | "pulse"
  | "heartbeat"
  | "float"
  | "sway"
  | "spin"
  | "wiggle"
  | "shake"
  | "flicker"
  // Per-glyph loops: on text each character runs the cycle on its own delay
  // (see glyphLoopAt), so the motion travels along the line; on every other
  // kind the whole element runs it as one piece.
  | "wave"
  | "bounce"
  | "flip"
  | "flutter";

/** The loops that move each character on its own delay. */
export type GlyphLoopStyle = "wave" | "bounce" | "flip" | "flutter";

export const GLYPH_LOOP_STYLE_IDS: GlyphLoopStyle[] = ["wave", "bounce", "flip", "flutter"];

const GLYPH_LOOPS: Set<string> = new Set(GLYPH_LOOP_STYLE_IDS);

export function isGlyphLoopStyle(style: OverlayLoopStyle): style is GlyphLoopStyle {
  return GLYPH_LOOPS.has(style);
}

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
  "wipe",
  "rise",
  "drop",
  "grow",
  "flip",
  "swivel",
  "bounce",
  "wave",
  "converge",
  "streak",
  "tumble",
  "scatter",
];

/** The styles that move each character on its own delay. Text plays them glyph
 * by glyph; anything else plays the same motion as one piece. */
export type GlyphAnimStyle =
  | "rise"
  | "drop"
  | "grow"
  | "flip"
  | "swivel"
  | "bounce"
  | "wave"
  | "converge"
  | "streak"
  | "tumble"
  | "scatter";

export const GLYPH_ANIM_STYLE_IDS: GlyphAnimStyle[] = [
  "rise",
  "drop",
  "grow",
  "flip",
  "swivel",
  "bounce",
  "wave",
  "converge",
  "streak",
  "tumble",
  "scatter",
];

const GLYPH_STYLES: Set<string> = new Set(GLYPH_ANIM_STYLE_IDS);

export function isGlyphAnimStyle(style: OverlayAnimStyle): style is GlyphAnimStyle {
  return GLYPH_STYLES.has(style);
}

/**
 * Whether a style changes the element's pixels rather than moving them as one
 * picture. A cached bitmap under a transform can't express these, so both
 * renderers bake them frame by frame.
 */
export function bakesPixels(style: OverlayAnimStyle, isText: boolean): boolean {
  if (style === "wipe") return true;
  return isText && (style === "typewriter" || isGlyphAnimStyle(style));
}

export const OVERLAY_LOOP_STYLE_IDS: OverlayLoopStyle[] = [
  "pulse",
  "heartbeat",
  "float",
  "sway",
  "spin",
  "wiggle",
  "shake",
  "flicker",
  "wave",
  "bounce",
  "flip",
  "flutter",
];

export const OVERLAY_ANIM_STYLE_LABELS: Record<OverlayAnimStyle, string> = {
  fade: "Fade",
  pop: "Pop",
  zoom: "Zoom",
  slideleft: "Slide left",
  slideright: "Slide right",
  slideup: "Slide up",
  slidedown: "Slide down",
  typewriter: "Typewriter",
  wipe: "Wipe",
  rise: "Rise",
  drop: "Drop",
  grow: "Grow",
  flip: "Flip",
  swivel: "Swivel",
  bounce: "Bounce",
  wave: "Wave",
  converge: "Converge",
  streak: "Streak",
  tumble: "Tumble",
  scatter: "Scatter",
};

export const OVERLAY_LOOP_STYLE_LABELS: Record<OverlayLoopStyle, string> = {
  pulse: "Pulse",
  heartbeat: "Heartbeat",
  float: "Float",
  sway: "Sway",
  spin: "Spin",
  wiggle: "Wiggle",
  shake: "Shake",
  flicker: "Flicker",
  wave: "Wave",
  bounce: "Bounce",
  flip: "Flip",
  flutter: "Flutter",
};

/** Ramp length bounds, seconds (mirrors clip animations). */
export const OVERLAY_ANIM_MIN_SECONDS = 0.1;
export const OVERLAY_ANIM_MAX_SECONDS = 2;
export const OVERLAY_ANIM_DEFAULT_SECONDS = 0.5;

/** How far slides travel, in design px at the 1080 short side. */
export const SLIDE_TRAVEL = 120;
/** Float bob amplitude, design px. */
export const FLOAT_TRAVEL = 12;
/** Loop amplitudes, design px. */
const SWAY_TRAVEL = 18;
const SHAKE_TRAVEL = 7;
const WAVE_LOOP_TRAVEL = 16;
const BOUNCE_LOOP_TRAVEL = 24;
const FLUTTER_TRAVEL = 5;
/** Per-glyph travel distances, design px. */
const RISE_TRAVEL = 46;
const WAVE_TRAVEL = 26;
const STREAK_TRAVEL = 110;
const CONVERGE_SPREAD = 90;
const SCATTER_TRAVEL = 70;
/** The farthest a glyph ever strays from its resting spot — what the frame
 * sampler pads its crop region by. */
export const GLYPH_TRAVEL_MAX = 120;
/** Base loop periods in seconds at speed 1. */
export const LOOP_PERIODS: Record<OverlayLoopStyle, number> = {
  pulse: 1.2,
  heartbeat: 1.5,
  float: 2.4,
  sway: 2.8,
  spin: 4,
  wiggle: 0.9,
  shake: 0.5,
  flicker: 1.8,
  wave: 1.6,
  bounce: 1.6,
  flip: 3.2,
  flutter: 1.4,
};

/**
 * How far a loop strays from rest, in design px, and whether it turns. The
 * frame sampler crops an element to the box it lives in, so a loop that
 * travels has to say so or the sampler clips the motion off.
 */
export function loopExtent(style: OverlayLoopStyle | undefined): {
  travel: number;
  rotates: boolean;
} {
  switch (style) {
    case "float":
      return { travel: FLOAT_TRAVEL, rotates: false };
    case "sway":
      return { travel: SWAY_TRAVEL, rotates: true };
    case "shake":
      return { travel: SHAKE_TRAVEL, rotates: false };
    case "wave":
      return { travel: WAVE_LOOP_TRAVEL, rotates: false };
    case "bounce":
      return { travel: BOUNCE_LOOP_TRAVEL, rotates: false };
    case "flutter":
      return { travel: FLUTTER_TRAVEL, rotates: true };
    case "spin":
    case "wiggle":
      return { travel: 0, rotates: true };
    default:
      return { travel: 0, rotates: false };
  }
}

/** Where a per-glyph ramp stands. Renderers walk the element's characters and
 * ask `glyphAnimAt` where each one sits. */
export interface GlyphPhase {
  style: OverlayAnimStyle;
  /** 0 at the far end of the ramp, 1 at rest. */
  p: number;
  exiting: boolean;
}

/** Where a per-glyph loop stands: one number, 0 to 1 around the cycle. Each
 * character reads it at its own delay. */
export interface GlyphLoopPhase {
  style: GlyphLoopStyle;
  phase: number;
}

/** The transform an animation contributes at one moment. dx/dy are design px
 * (1080 short side); rotate is degrees; alpha multiplies the element opacity;
 * textProgress (0..1, typewriter only) is the share of characters shown;
 * reveal (0..1, wipe) is the share of the box uncovered from its left edge;
 * glyphs and glyphLoop replace the whole-element transform with a
 * per-character one, and both apply at once (a title can fly its letters in
 * and then keep them waving). */
export interface OverlayAnimState {
  dx: number;
  dy: number;
  scale: number;
  rotate: number;
  alpha: number;
  textProgress?: number;
  reveal?: number;
  glyphs?: GlyphPhase;
  glyphLoop?: GlyphLoopPhase;
}

/** How one character sits at a moment: offsets in design px, a scale per axis
 * (a flip runs its axis through zero), degrees, and its own opacity. */
export interface GlyphAnimState {
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  rotate: number;
  alpha: number;
}

const IDLE: OverlayAnimState = { dx: 0, dy: 0, scale: 1, rotate: 0, alpha: 1 };
const GLYPH_IDLE: GlyphAnimState = { dx: 0, dy: 0, sx: 1, sy: 1, rotate: 0, alpha: 1 };

const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3);
const easeInCubic = (p: number) => p * p * p;
const easeOutBack = (p: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
};

const easeOutBounce = (p: number) => {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (p < 1 / d1) return n1 * p * p;
  if (p < 2 / d1) return n1 * (p -= 1.5 / d1) * p + 0.75;
  if (p < 2.5 / d1) return n1 * (p -= 2.25 / d1) * p + 0.9375;
  return n1 * (p -= 2.625 / d1) * p + 0.984375;
};

const clamp01 = (p: number) => Math.min(1, Math.max(0, p));

/**
 * One glyph's motion at its own progress `q` (0 = the far end of the ramp,
 * 1 = at rest). `index`/`count` place it in the run, which is what a spread or
 * a scatter needs; a whole element playing the same style is glyph 0 of 1.
 */
function glyphMotion(
  style: OverlayAnimStyle,
  q: number,
  exiting: boolean,
  index: number,
  count: number
): GlyphAnimState {
  const away = 1 - easeOutCubic(q);
  const dir = exiting ? -1 : 1;
  const fade = (mult: number) => Math.min(1, q * mult);
  switch (style) {
    case "rise":
      return { ...GLYPH_IDLE, dy: away * RISE_TRAVEL * dir, alpha: q };
    case "drop":
      return { ...GLYPH_IDLE, dy: -away * RISE_TRAVEL * dir, alpha: q };
    case "grow": {
      const s = easeOutBack(q);
      return { ...GLYPH_IDLE, sx: s, sy: s, alpha: fade(2) };
    }
    case "flip":
      return { ...GLYPH_IDLE, sy: Math.cos((1 - q) * Math.PI), alpha: fade(4) };
    case "swivel":
      return { ...GLYPH_IDLE, sx: Math.cos((1 - q) * Math.PI), alpha: fade(4) };
    case "bounce":
      return {
        ...GLYPH_IDLE,
        dy: -(1 - easeOutBounce(q)) * RISE_TRAVEL * dir,
        alpha: fade(4),
      };
    case "wave":
      // Up from below with an arch past the resting line; run one after the
      // other, the arch is what reads as the wave.
      return {
        ...GLYPH_IDLE,
        dy: (away - Math.sin(q * Math.PI) * 0.6) * WAVE_TRAVEL,
        alpha: fade(2.5),
      };
    case "converge": {
      // Spread across the run, then pulled together into place.
      const frac = count > 1 ? (index / (count - 1)) * 2 - 1 : 0;
      return { ...GLYPH_IDLE, dx: frac * CONVERGE_SPREAD * away, alpha: fade(2) };
    }
    case "streak":
      return {
        ...GLYPH_IDLE,
        dx: -away * STREAK_TRAVEL * dir,
        sx: 1 + away * 0.5,
        alpha: fade(2),
      };
    case "tumble":
      return {
        ...GLYPH_IDLE,
        dy: -away * RISE_TRAVEL * 1.4 * dir,
        rotate: -away * 35 * dir,
        alpha: fade(2),
      };
    case "scatter": {
      // The golden angle spreads the directions evenly however many glyphs
      // there are, and the same index always flies the same way.
      const a = index * 2.399963;
      const reach = SCATTER_TRAVEL * (0.7 + 0.3 * (((index * 7919) % 13) / 13));
      return {
        ...GLYPH_IDLE,
        dx: Math.cos(a) * reach * away,
        dy: Math.sin(a) * reach * away,
        rotate: away * 25 * (index % 2 ? -1 : 1),
        alpha: q,
      };
    }
    default:
      return GLYPH_IDLE;
  }
}

/** Share of the ramp spent handing the motion from the first glyph to the
 * last; what's left is how long any one glyph takes. */
const GLYPH_STAGGER = 0.6;
const GLYPH_STAGGER_BY_STYLE: Partial<Record<OverlayAnimStyle, number>> = {
  converge: 0.25,
  wave: 0.75,
  flip: 0.7,
  swivel: 0.7,
};

/**
 * Where character `index` of `count` sits when its element's ramp stands at
 * `p`. Glyphs start in order and overlap, so the motion sweeps the line; an
 * exit sweeps out the way it came in.
 */
export function glyphAnimAt(
  style: OverlayAnimStyle,
  p: number,
  index: number,
  count: number,
  exiting: boolean
): GlyphAnimState {
  const n = Math.max(1, count);
  const i = exiting ? n - 1 - index : index;
  const stagger = GLYPH_STAGGER_BY_STYLE[style] ?? GLYPH_STAGGER;
  const from = n > 1 ? (i / (n - 1)) * stagger : 0;
  return glyphMotion(style, clamp01((clamp01(p) - from) / (1 - stagger)), exiting, index, n);
}

/** The whole-element stand-in for a per-glyph ramp: the same motion run once
 * over the box, for renderers that only have one cached picture to move. */
export function glyphFallback(phase: GlyphPhase): GlyphAnimState {
  return glyphMotion(phase.style, clamp01(phase.p), phase.exiting, 0, 1);
}

const TAU = Math.PI * 2;
const wrap01 = (v: number) => v - Math.floor(v);
/** Distance between two points on a cycle, either way round. */
const cyclicGap = (a: number, b: number) => {
  const d = Math.abs(wrap01(a) - wrap01(b));
  return Math.min(d, 1 - d);
};

/**
 * One glyph's place in a loop at cycle position `phase`. Every loop is exactly
 * periodic in `phase` — built from whole harmonics and wrapped offsets — which
 * is what lets the frame sampler render one cycle of pictures and repeat them
 * for as long as the element runs.
 *
 * `index`/`count` stagger the run: most of these hand the motion down the line
 * one character at a time, and a whole element playing the same loop is glyph
 * 0 of 1.
 */
function glyphLoopMotion(
  style: GlyphLoopStyle,
  phase: number,
  index: number,
  count: number
): GlyphAnimState {
  const n = Math.max(1, count);
  // Each character starts its turn a little later than the one before it, so
  // one cycle sweeps the whole line exactly once.
  const u = wrap01(phase - index / n);
  switch (style) {
    case "wave":
      return { ...GLYPH_IDLE, dy: -Math.sin(u * TAU) * WAVE_LOOP_TRAVEL };
    case "bounce": {
      // Up over the first half of the turn, a beat on the ground for the
      // second. The character stretches as it rises and squashes as it sits,
      // so the weight of the hop reads even at caption size.
      const hop = Math.max(0, Math.sin(u * TAU));
      const ground = Math.max(0, -Math.sin(u * TAU));
      return {
        ...GLYPH_IDLE,
        dy: -hop * BOUNCE_LOOP_TRAVEL,
        sx: 1 - 0.05 * hop + 0.08 * ground,
        sy: 1 + 0.07 * hop - 0.1 * ground,
      };
    }
    case "flip": {
      // A split-flap turn: one full revolution inside the character's window,
      // and it sits still for the rest of the cycle.
      const window = 0.4;
      return { ...GLYPH_IDLE, sy: Math.cos(TAU * Math.min(1, u / window)) };
    }
    case "flutter": {
      // No hand-off here: the golden angle gives every character its own place
      // in the cycle, so the line shimmers instead of sweeping.
      const a = index * 2.399963;
      return {
        ...GLYPH_IDLE,
        dx: Math.sin(TAU * phase + a) * FLUTTER_TRAVEL,
        dy: Math.sin(TAU * phase + a * 1.7) * FLUTTER_TRAVEL,
        rotate: Math.sin(2 * TAU * phase + a) * 5,
      };
    }
  }
}

/** Where character `index` of `count` sits with everything applied — the edge
 * ramp it is playing and the loop it is running, folded into one transform.
 * Every renderer that draws a title letter by letter calls this. */
export function glyphStateAt(
  state: { glyphs?: GlyphPhase; glyphLoop?: GlyphLoopPhase },
  index: number,
  count: number
): GlyphAnimState {
  const ramp = state.glyphs
    ? glyphAnimAt(state.glyphs.style, state.glyphs.p, index, count, state.glyphs.exiting)
    : GLYPH_IDLE;
  if (!state.glyphLoop) return ramp;
  const loop = glyphLoopMotion(state.glyphLoop.style, state.glyphLoop.phase, index, count);
  return {
    dx: ramp.dx + loop.dx,
    dy: ramp.dy + loop.dy,
    sx: ramp.sx * loop.sx,
    sy: ramp.sy * loop.sy,
    rotate: ramp.rotate + loop.rotate,
    alpha: ramp.alpha * loop.alpha,
  };
}

/** Whether this moment draws the element letter by letter. */
export function hasGlyphMotion(state: {
  glyphs?: GlyphPhase;
  glyphLoop?: GlyphLoopPhase;
}): boolean {
  return !!state.glyphs || !!state.glyphLoop;
}

/** The loop's contribution at `phase`, written onto the state the edge ramps
 * left. A per-glyph loop hands the characters their own cycle; on any other
 * kind it folds back into the one transform the element has. */
function applyLoop(
  state: OverlayAnimState,
  style: OverlayLoopStyle,
  phase: number,
  isText: boolean
): void {
  if (isGlyphLoopStyle(style)) {
    if (isText) {
      state.glyphLoop = { style, phase };
      return;
    }
    const g = glyphLoopMotion(style, phase, 0, 1);
    state.dx += g.dx;
    state.dy += g.dy;
    state.rotate += g.rotate;
    state.scale *= (g.sx + g.sy) / 2;
    state.alpha *= g.alpha;
    return;
  }
  const wave = Math.sin(phase * TAU);
  switch (style) {
    case "pulse":
      state.scale *= 1 + 0.06 * wave;
      break;
    case "heartbeat": {
      // Two thumps close together, then the rest of the cycle at rest — the
      // gap is what separates it from a pulse.
      const thump = (at: number, width: number) =>
        Math.exp(-Math.pow(cyclicGap(phase, at) / width, 2));
      state.scale *= 1 + 0.14 * thump(0.06, 0.045) + 0.09 * thump(0.2, 0.05);
      break;
    }
    case "float":
      state.dy += FLOAT_TRAVEL * wave;
      break;
    case "sway":
      // The tilt follows the glide, so the element leans into the turn.
      state.dx += SWAY_TRAVEL * wave;
      state.rotate += 3 * wave;
      break;
    case "spin":
      state.rotate += phase * 360;
      break;
    case "wiggle":
      state.rotate += 4 * wave;
      break;
    case "shake":
      // Stacked harmonics: erratic to watch, and still exactly periodic.
      state.dx += SHAKE_TRAVEL * (wave * 0.65 + Math.sin(3 * phase * TAU) * 0.35);
      state.dy +=
        SHAKE_TRAVEL *
        0.7 *
        (Math.sin(2 * phase * TAU) * 0.7 + Math.sin(5 * phase * TAU) * 0.3);
      break;
    case "flicker": {
      // Lit most of the way round, with one stuttering dip.
      const dip = Math.max(0, wave) * (0.6 + 0.4 * Math.sin(5 * phase * TAU));
      state.alpha *= 1 - 0.55 * Math.max(0, dip);
      break;
    }
  }
}

/** One edge ramp. `p` runs 0→1 over the window in play direction for "in";
 * for "out" the caller feeds remaining-share so the motion mirrors. Text hands
 * the per-glyph styles to the renderer as a phase; every other kind plays the
 * same motion as one piece. */
function edgeState(
  style: OverlayAnimStyle,
  p: number,
  exiting: boolean,
  isText: boolean
): OverlayAnimState {
  const clamped = Math.min(1, Math.max(0, p));
  if (isGlyphAnimStyle(style)) {
    if (isText) return { ...IDLE, glyphs: { style, p: clamped, exiting } };
    const g = glyphFallback({ style, p: clamped, exiting });
    return {
      dx: g.dx,
      dy: g.dy,
      scale: (g.sx + g.sy) / 2,
      rotate: g.rotate,
      alpha: g.alpha,
    };
  }
  switch (style) {
    case "wipe":
      return { ...IDLE, reveal: clamped };
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
  dur: number,
  isText = false
): OverlayAnimState {
  if (!anim) return IDLE;
  let state = { ...IDLE };

  const inSecs = anim.in ? Math.min(anim.in.seconds, dur) : 0;
  const outSecs = anim.out ? Math.min(anim.out.seconds, Math.max(0, dur - inSecs)) : 0;

  if (anim.in && tLocal < inSecs) {
    state = edgeState(anim.in.style, tLocal / inSecs, false, isText);
  } else if (anim.out && tLocal > dur - outSecs) {
    state = edgeState(anim.out.style, (dur - tLocal) / outSecs, true, isText);
  }

  if (anim.loop) {
    const speed = anim.loop.speed > 0 ? anim.loop.speed : 1;
    const period = LOOP_PERIODS[anim.loop.style] / speed;
    applyLoop(state, anim.loop.style, wrap01(tLocal / period), isText);
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
