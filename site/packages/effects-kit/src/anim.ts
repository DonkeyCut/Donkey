/**
 * Overlay animation: preset In / Out / Loop slots evaluated by one pure
 * function. The DOM preview applies the result as a per-frame CSS transform;
 * the export samples the same function into rasterized frames — a single
 * evaluator is what keeps the two in lockstep.
 *
 * None of the motion lives here. Every entrance, exit, loop and hold move is
 * keyframe data under motion/, written in the After Effects
 * text-animator shape (keyframed properties plus a range selector) that
 * Lottie serializes. This module is the adapter: it names the slots, holds
 * the ids saved in project docs, and folds the evaluator's per-unit poses
 * into the shapes the renderers already draw.
 */

import {
  edgePreset,
  EDGE_IDS,
  holdPreset,
  loopPreset,
  LOOP_IDS,
  MOTION,
  PER_UNIT_EDGE_IDS,
  PER_UNIT_LOOP_IDS,
} from "./motion/catalog";
import { evalPreset, evalWhole, presetExtent, sampleProperties } from "./motion/evaluate";
import type { MotionPose, MotionPreset } from "./motion/types";

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
  // (the preset carries a range selector); on every other kind the whole
  // element runs it once.
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
  // Per-glyph loops: on text each character runs the cycle on its own delay;
  // on every other kind the whole element runs it as one piece.
  | "wave"
  | "bounce"
  | "flip"
  | "flutter";

/** The loops that move each character on its own delay. */
export type GlyphLoopStyle = "wave" | "bounce" | "flip" | "flutter";

/** The styles that move each character on its own delay. Text plays them
 * glyph by glyph; anything else plays the same motion as one piece. */
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

/**
 * A ramp at one end of the element.
 *
 * `preset` is a composed animation the project carries itself, in the same
 * shape as a catalog entry — the evaluator cannot tell the two apart, so
 * anything a composer writes plays everywhere a catalog preset does. When it
 * is set it is what plays, and `style` stays the nearest catalog name so
 * menus, tools and prompts still have something to call it.
 */
export interface OverlayEdge {
  style: OverlayAnimStyle;
  seconds: number;
  preset?: MotionPreset;
}

/** The cycle an element runs for its whole duration; `speed` multiplies the
 * base rate (1 = default, 2 = twice as fast). Carries its own preset on the
 * same terms as an edge. */
export interface OverlayLoop {
  style: OverlayLoopStyle;
  speed: number;
  preset?: MotionPreset;
}

/** What the element does while it holds — the push that never stops, the
 * drift across the frame. A hold-catalog id evaluated across the element's
 * whole span; `strength` scales every offset from rest and leaves the timing
 * alone. The keyframe pose track stays the user's own tier: a move never
 * writes keys. */
export interface OverlayMove {
  style: string;
  strength: number;
}

export interface OverlayAnim {
  in?: OverlayEdge;
  out?: OverlayEdge;
  loop?: OverlayLoop;
  move?: OverlayMove;
}

/** The motion a slot plays: the one it carries, or the catalog entry it
 * names. Everything downstream reads the preset, never the id. */
export const edgeMotion = (slot: OverlayEdge | undefined): MotionPreset | undefined =>
  slot ? (slot.preset ?? edgePreset(slot.style)) : undefined;

export const loopMotion = (slot: OverlayLoop | undefined): MotionPreset | undefined =>
  slot ? (slot.preset ?? loopPreset(slot.style)) : undefined;

export const moveMotion = (slot: OverlayMove | undefined): MotionPreset | undefined =>
  slot ? holdPreset(slot.style) : undefined;

// ── the registries, read from the catalog ─────────────────────────────────
// A preset added to the motion catalog appears in every menu, tool enum and prompt
// without being named anywhere else. The unions above stay hand-written:
// they are the ids saved in project docs, and a test holds them to the data.

export const OVERLAY_ANIM_STYLE_IDS = EDGE_IDS as OverlayAnimStyle[];
export const OVERLAY_LOOP_STYLE_IDS = LOOP_IDS as OverlayLoopStyle[];
export const GLYPH_ANIM_STYLE_IDS = PER_UNIT_EDGE_IDS as GlyphAnimStyle[];
export const GLYPH_LOOP_STYLE_IDS = PER_UNIT_LOOP_IDS as GlyphLoopStyle[];

const GLYPH_STYLES: Set<string> = new Set(GLYPH_ANIM_STYLE_IDS);
const GLYPH_LOOPS: Set<string> = new Set(GLYPH_LOOP_STYLE_IDS);

export function isGlyphAnimStyle(style: OverlayAnimStyle): style is GlyphAnimStyle {
  return GLYPH_STYLES.has(style);
}

export function isGlyphLoopStyle(style: OverlayLoopStyle): style is GlyphLoopStyle {
  return GLYPH_LOOPS.has(style);
}

export const OVERLAY_ANIM_STYLE_LABELS = Object.fromEntries(
  EDGE_IDS.map((id) => [id, MOTION.edges[id].label])
) as Record<OverlayAnimStyle, string>;

export const OVERLAY_LOOP_STYLE_LABELS = Object.fromEntries(
  LOOP_IDS.map((id) => [id, MOTION.loops[id].label])
) as Record<OverlayLoopStyle, string>;

/** Base loop periods in seconds at speed 1. */
export const LOOP_PERIODS = Object.fromEntries(
  LOOP_IDS.map((id) => [id, MOTION.loops[id].period ?? 1])
) as Record<OverlayLoopStyle, number>;

/** Ramp length bounds, seconds (mirrors clip animations). */
export const OVERLAY_ANIM_MIN_SECONDS = 0.1;
export const OVERLAY_ANIM_MAX_SECONDS = 2;
export const OVERLAY_ANIM_DEFAULT_SECONDS = 0.5;

/**
 * Whether a style changes the element's pixels rather than moving them as one
 * picture. A cached bitmap under a transform can't express these, so both
 * renderers bake them frame by frame.
 */
export function bakesPixels(slot: OverlayEdge | undefined, isText: boolean): boolean {
  const preset = edgeMotion(slot);
  if (!preset) return false;
  if (preset.animate.reveal) return true; // a wipe clips whatever it is over
  if (!isText) return false;
  // A typewriter types characters; a selector moves them one at a time.
  return !!preset.animate.typed || !!preset.selector;
}

/**
 * How far a loop strays from rest, in design px, and whether it turns. The
 * frame sampler crops an element to the box it lives in, so a loop that
 * travels has to say so or the sampler clips the motion off.
 */
export function loopExtent(slot: OverlayLoop | undefined): {
  travel: number;
  rotates: boolean;
} {
  const preset = loopMotion(slot);
  return preset ? presetExtent(preset) : { travel: 0, rotates: false };
}

/** How far a move strays from rest at its strength — travel in design px,
 * whether it turns, and the largest scale it reaches. The frame sampler pads
 * its crop by all three. */
export function moveExtent(slot: OverlayMove | undefined): {
  travel: number;
  rotates: boolean;
  scale: number;
} {
  const preset = moveMotion(slot);
  if (!preset || !slot) return { travel: 0, rotates: false, scale: 1 };
  const k = slot.strength > 0 ? slot.strength : 1;
  const base = presetExtent(preset);
  let s = 1;
  for (const key of preset.animate.scale ?? []) s = Math.max(s, key.v[0], key.v[1]);
  return { travel: base.travel * k, rotates: base.rotates, scale: 1 + (s - 1) * k };
}

/** Where a per-glyph ramp stands. Renderers walk the element's characters and
 * ask `glyphAnimAt` where each one sits. */
export interface GlyphPhase {
  style: OverlayAnimStyle;
  /** The slot's own preset, carried through so a composed animation reaches
   * the characters the same way a catalog one does. */
  preset?: MotionPreset;
  /** 0 at the far end of the ramp, 1 at rest. */
  p: number;
  exiting: boolean;
}

/** Where a per-glyph loop stands: one number, 0 to 1 around the cycle. Each
 * character reads it at its own delay. */
export interface GlyphLoopPhase {
  style: GlyphLoopStyle;
  preset?: MotionPreset;
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

const wrap01 = (v: number) => v - Math.floor(v);

/** A unit's share of the line's spread: -1 at the head, +1 at the tail. This
 * is what turns the tracking property into a per-character offset. */
const trackShare = (index: number, count: number) =>
  count > 1 ? (index / (count - 1)) * 2 - 1 : 0;

/** An evaluator pose as the per-glyph state the renderers draw. */
function asGlyph(pose: MotionPose, index: number, count: number): GlyphAnimState {
  return {
    dx: pose.dx + trackShare(index, count) * pose.tracking,
    dy: pose.dy,
    sx: pose.sx,
    sy: pose.sy,
    rotate: pose.rotate,
    alpha: pose.alpha,
  };
}

/**
 * Where character `index` of `count` sits when its element's ramp stands at
 * `p`. Glyphs start in order and overlap, so the motion sweeps the line; an
 * exit sweeps out the way it came in.
 */
export function glyphAnimAt(phase: GlyphPhase, index: number, count: number): GlyphAnimState {
  const { p, exiting } = phase;
  const preset = phase.preset ?? edgePreset(phase.style);
  // Only a preset with a selector has anything to say per character; a
  // whole-element style leaves its glyphs where they are.
  if (!preset?.selector) return GLYPH_IDLE;
  const n = Math.max(1, count);
  return asGlyph(evalPreset(preset, p, index, n, exiting), index, n);
}

/** Where character `index` of `count` sits with everything applied — the edge
 * ramp it is playing and the loop it is running, folded into one transform.
 * Every renderer that draws a title letter by letter calls this. */
export function glyphStateAt(
  state: { glyphs?: GlyphPhase; glyphLoop?: GlyphLoopPhase },
  index: number,
  count: number
): GlyphAnimState {
  const ramp = state.glyphs ? glyphAnimAt(state.glyphs, index, count) : GLYPH_IDLE;
  if (!state.glyphLoop) return ramp;
  const preset = state.glyphLoop.preset ?? loopPreset(state.glyphLoop.style);
  if (!preset) return ramp;
  const n = Math.max(1, count);
  const loop = asGlyph(evalPreset(preset, state.glyphLoop.phase, index, n, false), index, n);
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

/** One edge ramp. `p` runs 0→1 over the window in play direction for "in";
 * for "out" the caller feeds remaining-share so the motion mirrors. Text hands
 * the per-glyph styles to the renderer as a phase; every other kind plays the
 * same motion as one piece. */
function edgeState(
  slot: OverlayEdge,
  p: number,
  exiting: boolean,
  isText: boolean
): OverlayAnimState {
  const preset = edgeMotion(slot);
  if (!preset) return { ...IDLE };
  const clamped = Math.min(1, Math.max(0, p));
  if (preset.selector && isText)
    return {
      ...IDLE,
      glyphs: { style: slot.style, preset: slot.preset, p: clamped, exiting },
    };
  // Anything with no characters to hand the motion to plays it once over the
  // whole box.
  const pose = evalWhole(preset, clamped, exiting);
  const state: OverlayAnimState = {
    dx: pose.dx,
    dy: pose.dy,
    scale: (pose.sx + pose.sy) / 2,
    rotate: pose.rotate,
    alpha: pose.alpha,
  };
  // A typewriter on anything but text has no characters to reveal, so the
  // element just holds — the same as it always did.
  if (pose.typed !== undefined) state.textProgress = pose.typed;
  if (pose.reveal !== undefined) state.reveal = pose.reveal;
  return state;
}

/** The loop's contribution at `phase`, written onto the state the edge ramps
 * left. A per-glyph loop hands the characters their own cycle; on any other
 * kind it folds back into the one transform the element has. */
function applyLoop(
  state: OverlayAnimState,
  slot: OverlayLoop,
  phase: number,
  isText: boolean
): void {
  const preset = loopMotion(slot);
  if (!preset) return;
  if (preset.selector && isText) {
    state.glyphLoop = { style: slot.style as GlyphLoopStyle, preset: slot.preset, phase };
    return;
  }
  const pose = evalPreset(preset, phase, 0, 1, false);
  state.dx += pose.dx;
  state.dy += pose.dy;
  state.rotate += pose.rotate;
  state.scale *= (pose.sx + pose.sy) / 2;
  state.alpha *= pose.alpha;
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
    state = edgeState(anim.in, tLocal / inSecs, false, isText);
  } else if (anim.out && tLocal > dur - outSecs) {
    state = edgeState(anim.out, (dur - tLocal) / outSecs, true, isText);
  }

  if (anim.loop) {
    const period = loopPeriod(anim) ?? 1;
    applyLoop(state, anim.loop, wrap01(tLocal / period), isText);
  }
  if (anim.move) applyMove(state, anim.move, tLocal, dur);
  return state;
}

/** The move's contribution at `tLocal`: the hold preset sampled across the
 * element's whole [0, dur] span, every offset from rest scaled by strength,
 * folded onto the state the ramps and the loop left. */
function applyMove(state: OverlayAnimState, slot: OverlayMove, tLocal: number, dur: number): void {
  const preset = moveMotion(slot);
  if (!preset || dur <= 0) return;
  const k = slot.strength > 0 ? slot.strength : 1;
  const pose = sampleProperties(preset.animate, tLocal / dur, dur);
  state.dx += pose.dx * k;
  state.dy += pose.dy * k;
  state.rotate += pose.rotate * k;
  state.scale *= 1 + ((pose.sx + pose.sy) / 2 - 1) * k;
  state.alpha *= 1 + (pose.alpha - 1) * k;
}

/** The loop's exact cycle length in seconds (frame sequences render one cycle
 * and repeat it), or null when the element has no loop. */
export function loopPeriod(anim: OverlayAnim | undefined): number | null {
  if (!anim?.loop) return null;
  const speed = anim.loop.speed > 0 ? anim.loop.speed : 1;
  const base = loopMotion(anim.loop)?.period ?? LOOP_PERIODS[anim.loop.style] ?? 1;
  return base / speed;
}

/** Whether any slot is set (an element with an empty anim object is static). */
export function hasOverlayAnim(anim: OverlayAnim | undefined): boolean {
  return !!anim && (!!anim.in || !!anim.out || !!anim.loop || !!anim.move);
}

/**
 * A hold move sampled into an element pose track: absolute poses at seconds
 * from its start. Moves used to ship this way — written onto `kf` — and docs
 * saved then still carry these tracks; the loader regenerates them through
 * here to recognize which move wrote one and lift it into `anim.move`.
 */
export function holdMoveKeys(
  id: string,
  rest: { x: number; y: number; rotation: number },
  dur: number,
  /** Multiplies every offset from rest. 1 is the move as written; below it
   * the same shape reads quieter, above it harder. The timing never changes,
   * so a move stays on the beat whatever it is scaled to. */
  strength = 1,
  frameShortSide = 1080
): { t: number; x: number; y: number; scale: number; rotation: number; opacity: number }[] | undefined {
  const preset = holdPreset(id);
  if (!preset || dur <= 0.15) return undefined;
  const pose = (t: number) => sampleProperties(preset.animate, t, dur);
  const seeds = new Set<number>([0, 1]);
  for (const track of Object.values(preset.animate))
    for (const k of track) seeds.add(k.tMax === undefined ? k.t : Math.min(k.t, k.tMax / dur));
  const times = [...seeds].sort((a, b) => a - b);
  // The preset's own keys are not enough by themselves: a pose track runs
  // straight between its keys, so an eased push would arrive at a constant
  // rate and a circling move would draw a polygon. Each gap is halved until
  // the straight line across it matches the curve, which leaves an even move
  // at its two keys and spends keys only where there is a bend.
  const track: number[] = [times[0]];
  const fill = (a: number, b: number, depth: number): void => {
    if (depth < SUBDIVIDE_MAX && bends(a, b, pose)) {
      const m = (a + b) / 2;
      fill(a, m, depth + 1);
      fill(m, b, depth + 1);
    } else track.push(b);
  };
  for (let i = 0; i < times.length - 1; i++) fill(times[i], times[i + 1], 0);
  const px = 1 / frameShortSide;
  const k = strength;
  const keys = track
    .map((t) => {
      const p = pose(t);
      return {
        t: Math.round(t * dur * 1000) / 1000,
        x: rest.x + p.dx * px * k,
        y: rest.y + p.dy * px * k,
        scale: 1 + ((p.sx + p.sy) / 2 - 1) * k,
        rotation: rest.rotation + p.rotate * k,
        opacity: 1 + (p.alpha - 1) * k,
      };
    })
    .filter((key, i, all) => i === 0 || key.t > all[i - 1].t + 1e-3);
  return keys.length > 1 ? keys : undefined;
}

/** How many times a gap may be halved before the curve across it is called
 * close enough. */
const SUBDIVIDE_MAX = 4;

/** Whether the motion across a gap leaves the straight line between its ends
 * by enough to see. Three points are checked rather than one, because the
 * ease most of these presets are written with is symmetric: it is exactly on
 * the line at the middle and furthest off it at the quarters. Tolerances are
 * design px of travel, degrees of turn, and shares of scale and opacity. */
function bends(a: number, b: number, pose: (t: number) => MotionPose): boolean {
  const pa = pose(a);
  const pb = pose(b);
  for (const f of [0.25, 0.5, 0.75]) {
    const p = pose(a + (b - a) * f);
    const off = (u: number, w: number, v: number) => Math.abs(u + (w - u) * f - v);
    if (
      off(pa.dx, pb.dx, p.dx) > 1.5 ||
      off(pa.dy, pb.dy, p.dy) > 1.5 ||
      off(pa.rotate, pb.rotate, p.rotate) > 0.5 ||
      off(pa.sx, pb.sx, p.sx) > 0.006 ||
      off(pa.sy, pb.sy, p.sy) > 0.006 ||
      off(pa.alpha, pb.alpha, p.alpha) > 0.015
    )
      return true;
  }
  return false;
}
