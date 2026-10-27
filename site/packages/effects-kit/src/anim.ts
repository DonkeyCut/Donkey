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
  hitPreset,
  HIT_IDS,
  holdPreset,
  loopPreset,
  LOOP_IDS,
  MOTION,
  PER_UNIT_EDGE_IDS,
  PER_UNIT_LOOP_IDS,
} from "./motion/catalog";
import { evalPreset, evalWhole, presetExtent, sampleProperties } from "./motion/evaluate";
import type { OverlayFontCycle } from "./fontCycle";
import type { MotionPose, MotionPreset } from "./motion/types";
import type { OverlayWords } from "./words";
import { splitScale } from "./stretch";
import { capStreak, ELEMENT_BLUR_MAX } from "./camera";
import { EASE_BEZIER, easeAt, type EaseId } from "./ease";
import { SLOT_PITCH, type ReelDirection, type ReelShape } from "./dive";

export type OverlayAnimStyle =
  | "fade"
  | "pop"
  | "zoom"
  | "slideleft"
  | "slideright"
  | "slideup"
  | "slidedown"
  | "typewriter" // text only; other kinds render it as a fade
  | "count" // text only, like typewriter
  | "wipe"
  | "dive"
  | "disintegrate"
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
  | "scatter"
  | "slot"
  | "blur"
  | "glitch"
  | "flicker";

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
  | "scatter"
  | "slot"
  | "blur"
  | "glitch"
  | "flicker";

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
  /** The typing bar, on an entrance that types (typewriter). Every other
   * entrance ignores it. */
  caret?: OverlayCaret;
  /** A per-letter style's hand-off, 0..1: the share of the ramp spent
   * passing the motion from the first letter to the last (0 = every letter
   * together, near 1 = one at a time). Absent = the style's own. */
  stagger?: number;
  /** The order a per-letter style deals the letters their turns: "shuffle"
   * plays them in a fixed scattered order (After Effects' Randomize Order);
   * a list names the characters by index (the glyph count: spaces and line
   * breaks included) in the order they go, an order read off a reference.
   * Absent = the style's own, reading order for most. */
  order?: EdgeOrder | number[];
  /** With an order named as a list: when each of its characters starts, as a
   * share of the hand-off (0 the first, 1 the last), for letters read off a
   * reference that do not go evenly spaced. Absent = evenly spaced. */
  orderAt?: number[];
  /** How far the style travels from rest at its far end, design px (1080
   * short side): a drop from high above the frame, a long slide. Absent =
   * the style's own reach. */
  distance?: number;
  /** The curve the move travels on, over the style's own: a letter falling
   * at a steady pace is linear, one that brakes into place an ease out. */
  ease?: EaseId;
  /** false: no fade — the element (each letter) stays solid the whole way
   * in or out, as a letter falling in from beyond the frame does. A share of
   * the move, 0..1: it fades up over that much of its move and holds solid
   * after. Absent or true = the style's own. */
  fade?: boolean | number;
  /** Defocus at the far end, design px: each letter (the element) comes in
   * that soft and sharpens as it lands, on the move's own curve — a letter
   * falling out of focus. 0 takes a soft style's own blur away. Absent = the
   * style's own. */
  blur?: number;
  /** Slot only: which way the reel turns (up brings each character in from
   * below, down from above). Absent = up. */
  reel?: ReelDirection;
  /** Slot only: how far apart the reel's characters sit, em of the type
   * size. Absent = the style's own, tighter than a line. */
  pitch?: number;
  /** Slot only: how far the band the reel shows through reaches either side
   * of the line's middle, em. Absent = the line itself. */
  band?: number;
  /** Slot only: how far, em, the reel runs past each character's slot before
   * it settles back into it — a reel that lands with a bounce. */
  overshoot?: number;
  /** Slot only, with an overshoot: the share of each character's move spent
   * settling back from the far side, 0..0.6. Absent = 0.3. */
  settle?: number;
  /** Dive only: the point the view zooms about, design px (1080 short side)
   * from the element's center at rest. It holds where it stands, as a zoom
   * about a fixed point does, instead of the deepest ink flying to the
   * frame's center. Absent = the deepest ink of the last letter. */
  anchor?: { x: number; y: number };
}

export type EdgeOrder = "reading" | "shuffle";
export const EDGE_ORDERS: readonly EdgeOrder[] = ["reading", "shuffle"];
/** The farthest an edge's distance may send it, design px: past any frame. */
export const EDGE_DISTANCE_MAX = 4000;
/** The softest an edge's far end may be, design px: an element's own blur cap. */
export const EDGE_BLUR_MAX = ELEMENT_BLUR_MAX;
/** Seeds the shuffled order, so the same title always scatters the same way. */
const EDGE_SHUFFLE_SEED = 5;

/**
 * The bar at the end of the typed text. It holds solid while the entrance
 * types, then blinks for the rest of the element's life, or for `blinks`
 * blinks and then stays lit (or goes, with `hide`). With `blink` off it
 * holds solid after typing, or goes with `hide`.
 */
export interface OverlayCaret {
  blink: boolean;
  /** How many times it blinks once typing stops; absent = for as long as
   * the element is up. */
  blinks?: number;
  /** Gone after its last blink (or right after typing, with blink off). */
  hide?: boolean;
  /** Hex; absent = the text's own color. */
  color?: string;
}

/** Half a blink: the bar is lit this long, then dark this long — the rate a
 * desktop text field blinks at. */
export const CARET_BLINK_SECONDS = 0.53;
/** Bar geometry in em of the type size: its width, its height, and the gap
 * between the last character and the bar. Both painters read these. */
export const CARET_WIDTH_EM = 0.07;
export const CARET_HEIGHT_EM = 1;
export const CARET_GAP_EM = 0.04;
/** The most blinks the panel and the tools offer. */
export const CARET_BLINKS_MAX = 20;

/**
 * A one-shot hit: a catalog motion played once, over `seconds`, starting `at`
 * seconds into the element (a button press). Unlike the edges it sits inside
 * the element's life, and unlike a loop it plays exactly once. `darken` lets
 * the preset's brightness track through; off, the hit only moves.
 */
export interface OverlayHit {
  style: string;
  at: number;
  seconds: number;
  darken?: boolean;
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
  /** Word-by-word emphasis (see words.ts). Text only: every other kind
   * ignores it, the way typewriter is offered on titles alone. */
  words?: OverlayWords;
  hit?: OverlayHit;
  /** A stretch of typefaces the title cycles through (see fontCycle.ts).
   * Text only, like the word effects. */
  fonts?: OverlayFontCycle;
}

/** The motion a slot plays: the one it carries, or the catalog entry it
 * names. Everything downstream reads the preset, never the id. */
export const edgeMotion = (slot: OverlayEdge | undefined): MotionPreset | undefined => {
  if (!slot) return undefined;
  const base = slot.preset ?? edgePreset(slot.style);
  const plain =
    slot.order === undefined &&
    !(slot.distance! > 0) &&
    !slot.ease &&
    (slot.fade === undefined || slot.fade === true) &&
    slot.blur === undefined &&
    !hasReelShape(slot);
  if (!base || plain) return base;
  let made = shaped.get(slot);
  if (!made) {
    made = shapeEdge(base, slot);
    shaped.set(slot, made);
  }
  return made;
};

/** How far a preset's motion travels from rest, design px: the reach an
 * edge's `distance` replaces. 0 for a style that never moves. */
export function presetReach(preset: MotionPreset): number {
  const reach = (props: MotionPreset["animate"] | undefined) =>
    Math.max(0, ...(props?.position ?? []).map((k) => Math.max(Math.abs(k.v[0]), Math.abs(k.v[1]))));
  return Math.max(reach(preset.animate), reach(preset.animateOut));
}

/** The style's own reach under a slot, before its distance: what the slot
 * plays with no distance set. */
export const edgeOwnReach = (slot: OverlayEdge | undefined): number => {
  const base = slot ? (slot.preset ?? edgePreset(slot.style)) : undefined;
  return base ? presetReach(base) : 0;
};

/** Glyph indices for letters counted the way a person reads them: `letters`
 * numbers the text's characters from 0, skipping spaces and line breaks;
 * the glyph count the renderers walk includes both. Out-of-range numbers
 * drop out. */
export function letterSequence(text: string, letters: number[]): number[] {
  const at: number[] = [];
  let gi = 0;
  for (const line of text.split("\n")) {
    for (const ch of line) {
      if (!/\s/.test(ch)) at.push(gi);
      gi++;
    }
    gi++; // the line break takes a turn too
  }
  const seen = new Set<number>();
  return letters.filter((k) => Number.isInteger(k) && k >= 0 && k < at.length && !seen.has(k) && seen.add(k)).map((k) => at[k]);
}

/** Slots are replaced, never edited, so a shaped preset stays good for as
 * long as its slot lives. */
const shaped = new WeakMap<OverlayEdge, MotionPreset>();

/** The slot's own order and reach written into its preset, so every reader —
 * the glyph evaluator, the crop padding, both renderers — plays them. */
function shapeEdge(base: MotionPreset, slot: OverlayEdge): MotionPreset {
  let preset = base;
  if (Array.isArray(slot.order) && base.selector) {
    const timed = slot.orderAt?.length === slot.order.length ? { sequenceAt: slot.orderAt } : {};
    preset = { ...preset, selector: { ...base.selector, randomize: false, sequence: slot.order, ...timed } };
  } else if (slot.order && base.selector) {
    const randomize = slot.order === "shuffle";
    preset = {
      ...preset,
      selector: { ...base.selector, randomize, ...(randomize ? { seed: base.selector.seed ?? EDGE_SHUFFLE_SEED } : {}) },
    };
  }
  const own = presetReach(base);
  if (slot.distance! > 0 && own > 0) {
    const k = Math.min(EDGE_DISTANCE_MAX, slot.distance!) / own;
    const scaled = (props: MotionPreset["animate"]): MotionPreset["animate"] =>
      props.position
        ? { ...props, position: props.position.map((key) => ({ ...key, v: [key.v[0] * k, key.v[1] * k] as [number, number] })) }
        : props;
    preset = {
      ...preset,
      animate: scaled(preset.animate),
      ...(preset.animateOut ? { animateOut: scaled(preset.animateOut) } : {}),
    };
  }
  if (slot.ease || slot.fade === false || typeof slot.fade === "number" || slot.blur !== undefined) {
    const curve = slot.ease ? EASE_BEZIER[slot.ease] : undefined;
    const soft = slot.blur === undefined ? undefined : Math.min(EDGE_BLUR_MAX, Math.max(0, slot.blur));
    const reshaped = (props: MotionPreset["animate"]): MotionPreset["animate"] => {
      const next = { ...props };
      if (curve && next.position)
        next.position = next.position.map((key, k, all) => (k < all.length - 1 ? { ...key, ease: curve } : key));
      if (slot.fade === false) delete next.opacity;
      // A fade over the first share of the move, solid after.
      else if (typeof slot.fade === "number" && next.opacity)
        next.opacity = [
          { t: 0, v: 0, ease: EASE_BEZIER.linear },
          { t: Math.min(1, Math.max(0.01, slot.fade)), v: 1 },
          { t: 1, v: 1 },
        ];
      // The defocus clears on the move's own curve, so it is sharp as it lands.
      if (soft === 0) delete next.blur;
      else if (soft !== undefined)
        next.blur = [{ t: 0, v: soft, ease: curve ?? next.position?.[0]?.ease ?? EASE_BEZIER.linear }, { t: 1, v: 0 }];
      return next;
    };
    preset = {
      ...preset,
      animate: reshaped(preset.animate),
      ...(preset.animateOut ? { animateOut: reshaped(preset.animateOut) } : {}),
    };
  }
  if (preset.animate.roll && (slot.ease || hasReelShape(slot) || slot.fade === false)) {
    preset = reelEdge(preset, slot);
  }
  return preset;
}

/** The share of a character's move an overshoot spends settling back, when
 * the edge names none, and the most it may take. */
const SETTLE_DEFAULT = 0.3;
export const EDGE_SETTLE_MAX = 0.6;
/** The widest a slot reel's pitch, band or overshoot may be set, em. */
export const EDGE_REEL_EM_MAX = 4;
/** The style's own pitch in em, at the editor's default line height (render.ts
 * LINE_HEIGHT): what an overshoot is counted in characters against when the
 * edge names no pitch. */
const SLOT_PITCH_EM = SLOT_PITCH * 1.25;

/** Whether an edge sets any part of a slot's reel. */
const hasReelShape = (slot: OverlayEdge): boolean =>
  slot.reel !== undefined ||
  slot.pitch !== undefined ||
  slot.band !== undefined ||
  slot.overshoot !== undefined ||
  slot.settle !== undefined;

/** A slot edge's reel written into its preset: the roll on the edge's curve,
 * run past the slot and settled back when it overshoots, and the reel's shape
 * for the renderers to draw it by. */
function reelEdge(preset: MotionPreset, slot: OverlayEdge): MotionPreset {
  const keys = preset.animate.roll!;
  const from = keys[0].v;
  const curve = slot.ease ? EASE_BEZIER[slot.ease] : keys[0].ease;
  let roll = keys.map((key, k) => (k < keys.length - 1 && curve ? { ...key, ease: curve } : key));
  // An overshoot: the reel comes to rest past the slot, then glides back.
  const past = slot.overshoot! > 0 ? slot.overshoot! / (slot.pitch! > 0 ? slot.pitch! : SLOT_PITCH_EM) : 0;
  if (past > 0) {
    const settle = Math.min(EDGE_SETTLE_MAX, Math.max(0.05, slot.settle ?? SETTLE_DEFAULT));
    roll = [
      { t: 0, v: from, ...(curve ? { ease: curve } : {}) },
      { t: 1 - settle, v: -past, ease: EASE_BEZIER["sine.inOut"] },
      { t: 1, v: 0 },
    ];
  }
  const shape: ReelShape = {
    ...(slot.reel ? { dir: slot.reel } : {}),
    ...(slot.pitch! > 0 ? { pitch: slot.pitch } : {}),
    ...(slot.band! > 0 ? { band: slot.band } : {}),
    ...(slot.fade === false ? { solid: true } : {}),
  };
  // A solid reel is still out of sight before its turn: it shows whole the
  // moment it starts to roll, not standing still while it waits.
  const opacity = slot.fade === false ? [{ t: 0, v: 0, ease: EASE_BEZIER.linear }, { t: 0.001, v: 1 }, { t: 1, v: 1 }] : preset.animate.opacity;
  return {
    ...preset,
    animate: { ...preset.animate, roll, ...(opacity ? { opacity } : {}) },
    ...(Object.keys(shape).length ? { reel: shape } : {}),
  };
}

export const loopMotion = (slot: OverlayLoop | undefined): MotionPreset | undefined =>
  slot ? (slot.preset ?? loopPreset(slot.style)) : undefined;

export const moveMotion = (slot: OverlayMove | undefined): MotionPreset | undefined =>
  slot ? holdPreset(slot.style) : undefined;

const hitMotion = (slot: OverlayHit | undefined): MotionPreset | undefined =>
  slot ? hitPreset(slot.style) : undefined;

// ── the registries, read from the catalog ─────────────────────────────────
// A preset added to the motion catalog appears in every menu, tool enum and prompt
// without being named anywhere else. The unions above stay hand-written:
// they are the ids saved in project docs, and a test holds them to the data.

export const OVERLAY_ANIM_STYLE_IDS = EDGE_IDS as OverlayAnimStyle[];
export const OVERLAY_LOOP_STYLE_IDS = LOOP_IDS as OverlayLoopStyle[];
export const GLYPH_ANIM_STYLE_IDS = PER_UNIT_EDGE_IDS as GlyphAnimStyle[];
export const GLYPH_LOOP_STYLE_IDS = PER_UNIT_LOOP_IDS as GlyphLoopStyle[];
export const OVERLAY_HIT_STYLE_IDS = HIT_IDS;
export const OVERLAY_HIT_STYLE_LABELS: Record<string, string> = Object.fromEntries(
  HIT_IDS.map((id) => [id, MOTION.hits[id].label])
);
/** Each hit as "id: note", what tool schemas and prompts teach them from. */
export const hitNotes = (): string =>
  HIT_IDS.map((id) => `${id}: ${MOTION.hits[id].note ?? MOTION.hits[id].label}`).join(" ");

/** Hit length bounds, seconds. */
export const OVERLAY_HIT_MIN_SECONDS = 0.1;
export const OVERLAY_HIT_MAX_SECONDS = 1;
export const OVERLAY_HIT_DEFAULT_SECONDS = 0.3;

/** The edges that only play on characters — typing them out, rolling each up
 * a reel, counting the numbers up. Every other kind is offered the rest. */
export const TEXT_ONLY_ANIM_STYLE_IDS = EDGE_IDS.filter(
  (id) =>
    !!MOTION.edges[id].animate.typed ||
    !!MOTION.edges[id].animate.roll ||
    !!MOTION.edges[id].animate.counted
) as OverlayAnimStyle[];
/** The edges that fly the view into the element's ink until it fills the
 * frame. */
export const DIVE_ANIM_STYLE_IDS = EDGE_IDS.filter((id) => !!MOTION.edges[id].animate.dive) as OverlayAnimStyle[];

/** Each catalog edge that carries a note, as "id: note" lines — what tool
 * schemas and prompts teach the edges from. */
export const edgeNotes = (): string =>
  EDGE_IDS.filter((id) => MOTION.edges[id].note)
    .map((id) => `${id}: ${MOTION.edges[id].note}`)
    .join(" ");

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
/** A per-letter ramp hands its motion along a whole line, so it may run
 * longer: a long title landing a letter at a time takes a few seconds. */
export const OVERLAY_GLYPH_ANIM_MAX_SECONDS = 4;

/** The longest ramp a style may run: its own cap, else the per-letter one,
 * else the shared one. */
export const edgeMaxSeconds = (style: string | undefined): number => {
  const preset = style ? edgePreset(style) : undefined;
  return preset?.maxSeconds ?? (preset?.selector ? OVERLAY_GLYPH_ANIM_MAX_SECONDS : OVERLAY_ANIM_MAX_SECONDS);
};

/** The most of a ramp the letter hand-off may take: at 1 each letter would
 * get no time of its own to move. */
export const EDGE_STAGGER_MAX = 0.95;

/** The hand-off a per-letter edge plays with — its own, else its style's;
 * undefined for a style that moves the element as one piece. */
export const edgeStagger = (slot: OverlayEdge | undefined): number | undefined => {
  const sel = edgeMotion(slot)?.selector;
  if (!sel) {
    return undefined;
  }
  return slot?.stagger ?? sel.spread;
};

/**
 * Whether a style changes the element's pixels rather than moving them as one
 * picture. A cached bitmap under a transform can't express these, so both
 * renderers bake them frame by frame.
 */
export function bakesPixels(slot: OverlayEdge | undefined, isText: boolean): boolean {
  const preset = edgeMotion(slot);
  if (!preset) return false;
  if (preset.animate.reveal) return true; // a wipe clips whatever it is over
  if (preset.animate.erode) return true; // and a disintegration eats it
  if (!isText) return false;
  // A typewriter types characters, a count rewrites its numbers; a selector
  // moves them one at a time.
  return !!preset.animate.typed || !!preset.animate.counted || !!preset.selector;
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
  /** The slot's own hand-off, over the style's (see `OverlayEdge.stagger`). */
  stagger?: number;
  /** The ramp's length, seconds. */
  seconds?: number;
  /** The share of the ramp the shutter stays open, when the element wears
   * motion blur: each letter then streaks along its own move. */
  exposure?: number;
  /** The element's shutter, frames (caps the streak's length). */
  shutter?: number;
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
 * countProgress (0..1, count only) is the share of its value each number shows;
 * reveal (0..1, wipe) is the share of the box uncovered from its left edge;
 * glyphs and glyphLoop replace the whole-element transform with a
 * per-character one, and both apply at once (a title can fly its letters in
 * and then keep them waving). */
export interface OverlayAnimState {
  dx: number;
  dy: number;
  /** The larger axis; `sx`/`sy` stretch each axis over it (see stretch.ts),
   * so a whole-element flip turns one axis through zero. */
  scale: number;
  sx?: number;
  sy?: number;
  rotate: number;
  alpha: number;
  textProgress?: number;
  countProgress?: number;
  reveal?: number;
  /** 0..1 share of the ink eaten away (disintegrate). */
  erode?: number;
  /** 0..1 strength of the electric arcs over the element (zap hit). */
  zap?: number;
  glyphs?: GlyphPhase;
  glyphLoop?: GlyphLoopPhase;
  /** How far the view has flown into the element's deepest ink, 0..1 (dive).
   * Renderers turn it into a view with `diveView`, which needs the drawn
   * geometry this evaluator never sees. */
  dive?: number;
  /** The diving edge, when it zooms about its own anchor. */
  diveEdge?: "in" | "out";
  /** Whether the typing bar is lit (typewriter with a caret); absent when the
   * element has none. */
  caret?: boolean;
  /** Multiplies the element's colors (a hit that darkens); absent = 1. */
  brightness?: number;
  /** Defocus the ramp adds over the element's own, design px (blur). */
  blur?: number;
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
  /** Characters its reel still rolls past before it lands (slot); absent or
   * 0 = the character alone. `slotReel` says what to draw. */
  roll?: number;
  /** The reel's shape while it rolls, when its edge sets one. */
  reel?: ReelShape;
  /** Defocus, design px; absent = sharp. */
  blur?: number;
  /** How far a red and a cyan copy pull apart either side, design px; absent
   * = one copy. */
  split?: number;
  /** The motion blur streak: how far the letter travels while the shutter
   * is open, design px, centered on this moment. Absent = sharp. */
  streak?: { x: number; y: number };
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
    ...(pose.roll ? { roll: pose.roll } : {}),
    ...(pose.blur ? { blur: pose.blur } : {}),
    ...(pose.split ? { split: pose.split } : {}),
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
  const at = (q: number) => asGlyph(evalPreset(preset, q, index, n, exiting, 0, phase.stagger), index, n);
  const rolled = at(p);
  const g = rolled.roll && preset.reel ? { ...rolled, reel: preset.reel } : rolled;
  const e = phase.exposure ?? 0;
  if (!(e > 0)) return g;
  // The letter's travel over the part of the exposure inside the ramp,
  // scaled to the whole exposure, the way an element's own streak is.
  const p0 = Math.max(0, p - e / 2);
  const p1 = Math.min(1, p + e / 2);
  if (p1 - p0 < 1e-6) return g;
  const a = at(p0);
  const b = at(p1);
  const k = e / (p1 - p0);
  const streak = capStreak((b.dx - a.dx) * k, (b.dy - a.dy) * k, phase.shutter ?? 1);
  return streak ? { ...g, streak } : g;
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
  const roll = (ramp.roll ?? 0) + (loop.roll ?? 0);
  const blur = (ramp.blur ?? 0) + (loop.blur ?? 0);
  const split = (ramp.split ?? 0) + (loop.split ?? 0);
  return {
    dx: ramp.dx + loop.dx,
    dy: ramp.dy + loop.dy,
    sx: ramp.sx * loop.sx,
    sy: ramp.sy * loop.sy,
    rotate: ramp.rotate + loop.rotate,
    alpha: ramp.alpha * loop.alpha,
    ...(roll ? { roll } : {}),
    ...(roll && ramp.reel ? { reel: ramp.reel } : {}),
    ...(blur ? { blur } : {}),
    ...(split ? { split } : {}),
    ...(ramp.streak ? { streak: ramp.streak } : {}),
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
  isText: boolean,
  seconds: number
): OverlayAnimState {
  const preset = edgeMotion(slot);
  if (!preset) return { ...IDLE };
  const clamped = Math.min(1, Math.max(0, p));
  if (preset.selector && isText)
    return {
      ...IDLE,
      glyphs: {
        style: slot.style,
        preset,
        p: clamped,
        exiting,
        seconds,
        ...(slot.stagger !== undefined ? { stagger: slot.stagger } : {}),
      },
    };
  // Anything with no characters to hand the motion to plays it once over the
  // whole box.
  const pose = evalWhole(preset, clamped, exiting);
  const state: OverlayAnimState = {
    dx: pose.dx,
    dy: pose.dy,
    ...splitScale(pose.sx, pose.sy),
    rotate: pose.rotate,
    alpha: pose.alpha,
  };
  // A typewriter on anything but text has no characters to reveal, so the
  // element just holds — the same as it always did.
  if (pose.typed !== undefined) state.textProgress = pose.typed;
  if (pose.counted !== undefined) state.countProgress = pose.counted;
  if (pose.reveal !== undefined) state.reveal = pose.reveal;
  if (pose.erode !== undefined) state.erode = pose.erode;
  if (pose.dive !== undefined) state.dive = pose.dive;
  // A dive's ease is the flight's own curve on the edge's own clock: an
  // ease-in on an exit holds back early and rushes into the ink at the end.
  if (pose.dive !== undefined && slot.ease) state.dive = exiting ? easeAt(slot.ease, 1 - clamped) : 1 - easeAt(slot.ease, clamped);
  if (pose.dive !== undefined && slot.anchor) state.diveEdge = exiting ? "out" : "in";
  if (pose.blur) state.blur = pose.blur;
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
  foldAxes(state, pose.sx, pose.sy);
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
    state = edgeState(anim.in, tLocal / inSecs, false, isText, inSecs);
  } else if (anim.out && tLocal > dur - outSecs) {
    state = edgeState(anim.out, (dur - tLocal) / outSecs, true, isText, outSecs);
  }

  if (anim.loop) {
    const period = loopPeriod(anim) ?? 1;
    applyLoop(state, anim.loop, wrap01(tLocal / period), isText);
  }
  if (anim.move) applyMove(state, anim.move, tLocal, dur);
  if (anim.hit) applyHit(state, anim.hit, tLocal);
  if (isText) {
    const caret = caretOn(anim, tLocal, dur);
    if (caret !== undefined) state.caret = caret;
  }
  return state;
}

/** How long the hit plays: a stored hit without seconds plays the default,
 * the length the inspector shows for it. */
const hitSeconds = (slot: OverlayHit): number => (slot.seconds > 0 ? slot.seconds : OVERLAY_HIT_DEFAULT_SECONDS);

/** The hit's contribution at `tLocal`: nothing outside its window; inside,
 * the preset's pose folded onto what the other slots left, as one piece. */
function applyHit(state: OverlayAnimState, slot: OverlayHit, tLocal: number): void {
  const preset = hitMotion(slot);
  const q = (tLocal - slot.at) / hitSeconds(slot);
  if (!preset || !(q > 0 && q < 1)) return;
  const pose = evalWhole(preset, q, false);
  state.dx += pose.dx;
  state.dy += pose.dy;
  state.rotate += pose.rotate;
  foldAxes(state, pose.sx, pose.sy);
  state.alpha *= pose.alpha;
  if (slot.darken && pose.brightness !== undefined && pose.brightness !== 1)
    state.brightness = (state.brightness ?? 1) * pose.brightness;
  if (pose.zap !== undefined) {
    state.zap = pose.zap;
  }
}

/** Where the hit plays inside [0, dur], or null when there is none. The frame
 * samplers draw this window frame by frame. */
export function hitWindow(
  anim: OverlayAnim | undefined,
  dur: number
): { start: number; end: number } | null {
  const slot = anim?.hit;
  if (!slot || !hitMotion(slot)) return null;
  const start = Math.max(0, Math.min(dur, slot.at));
  const end = Math.max(start, Math.min(dur, slot.at + hitSeconds(slot)));
  return end - start > 1e-3 ? { start, end } : null;
}

/** Whether the hit paints arcs (zap): pixels the stamped export bakes frame
 * by frame across the hit's window. */
export const hitZaps = (anim: OverlayAnim | undefined): boolean => !!hitMotion(anim?.hit)?.animate.zap;

/** The largest scale a hit reaches, so the frame sampler can pad its crop. */
export function hitScale(anim: OverlayAnim | undefined): number {
  const preset = hitMotion(anim?.hit);
  let s = 1;
  for (const key of preset?.animate.scale ?? []) s = Math.max(s, key.v[0], key.v[1]);
  return s;
}

/** The typing bar an entrance keeps when it changes to `style`: the bar stays
 * while the new entrance still types. */
export function keepCaret(edge: OverlayEdge | undefined, style: string): OverlayCaret | undefined {
  return edgePreset(style)?.animate.typed ? edge?.caret : undefined;
}

/** The element's typing bar, when its entrance types and carries one. */
export function typeCaret(anim: OverlayAnim | undefined): OverlayCaret | undefined {
  const edge = anim?.in;
  if (!edge?.caret) return undefined;
  return edgeMotion(edge)?.animate.typed ? edge.caret : undefined;
}

/**
 * Whether the typing bar is lit at `tLocal`: solid while the entrance types,
 * then lit and dark by turns, CARET_BLINK_SECONDS each, starting lit.
 * Undefined when the element has no bar. Pure, so every renderer and every
 * sampler reads the same blink.
 */
export function caretOn(
  anim: OverlayAnim | undefined,
  tLocal: number,
  dur: number
): boolean | undefined {
  const caret = typeCaret(anim);
  if (!caret) return undefined;
  const typedBy = Math.min(anim!.in!.seconds, dur);
  if (tLocal < typedBy) return true;
  if (!caret.blink) return !caret.hide;
  const u = tLocal - typedBy;
  const cycle = CARET_BLINK_SECONDS * 2;
  if (caret.blinks !== undefined && caret.blinks > 0 && u >= caret.blinks * cycle) return !caret.hide;
  return u % cycle < CARET_BLINK_SECONDS;
}

/** The moments inside (0, dur) where the bar turns on or off, in order. The
 * frame samplers cut their still windows here, so a blink costs two pictures
 * and never a frame-by-frame run. */
export function caretToggles(anim: OverlayAnim | undefined, dur: number): number[] {
  const caret = typeCaret(anim);
  if (!caret) return [];
  const typedBy = Math.min(anim!.in!.seconds, dur);

  // A bar that holds after typing turns off once, when it hides.
  if (!caret.blink) return caret.hide && typedBy > 0 && typedBy < dur ? [typedBy] : [];

  // A blink flips every CARET_BLINK_SECONDS once typing stops, lit first. A
  // counted blink ends dark, then lights again for good unless it hides:
  // two blinks flip at 1, 2, 3 (hide) or 1, 2, 3, 4 (stay) half-cycles.
  const flips = caret.blinks !== undefined && caret.blinks > 0 ? caret.blinks * 2 - (caret.hide ? 1 : 0) : Infinity;
  const out: number[] = [];
  for (let k = 1; k <= flips; k++) {
    const t = typedBy + k * CARET_BLINK_SECONDS;
    if (t >= dur) break;
    out.push(t);
  }
  return out;
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
  foldAxes(state, 1 + (pose.sx - 1) * k, 1 + (pose.sy - 1) * k);
  state.alpha *= 1 + (pose.alpha - 1) * k;
}

/** Multiply a per-axis scale into the state, axis by axis, and split the
 * result back into its uniform scale and stretch. */
function foldAxes(state: OverlayAnimState, ax: number, ay: number): void {
  const next = splitScale(state.scale * (state.sx ?? 1) * ax, state.scale * (state.sy ?? 1) * ay);
  state.scale = next.scale;
  delete state.sx;
  delete state.sy;
  if (next.sx !== undefined) {
    state.sx = next.sx;
    state.sy = next.sy;
  }
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
  return (
    !!anim &&
    (!!anim.in || !!anim.out || !!anim.loop || !!anim.move || !!anim.words || !!anim.hit || !!anim.fonts)
  );
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
      // Baked axes keep a hold's squash: the key's scale is the larger axis
      // and scaleX/scaleY stretch each one over it.
      const size = splitScale(1 + (p.sx - 1) * k, 1 + (p.sy - 1) * k);
      return {
        t: Math.round(t * dur * 1000) / 1000,
        x: rest.x + p.dx * px * k,
        y: rest.y + p.dy * px * k,
        scale: size.scale,
        ...(size.sx !== undefined ? { scaleX: size.sx, scaleY: size.sy } : {}),
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
