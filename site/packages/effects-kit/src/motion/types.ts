/**
 * The motion preset format: keyframes plus a range selector.
 *
 * This is After Effects' text-animator model, which Lottie serializes and
 * which GSAP and Motion reimplement as "split text + stagger". An animation
 * is a keyframed pose, and a selector decides how that pose is handed from
 * one character to the next. Every entrance, exit, loop and hold move in the
 * app is one entry in that format, stored as data beside this file — there is
 * no second way to describe motion here.
 *
 * Times are normalized: `t` runs 0..1 across the window the preset is playing
 * in (an entrance ramp, an exit ramp, one loop cycle, or the element's whole
 * hold). Offsets are design px at the 1080 short side; scales multiply;
 * rotation is degrees clockwise; opacity multiplies the element's own.
 */

/** Cubic bezier timing handles, [x1, y1, x2, y2], the curve running [0,0] to
 * [1,1] — the same shape Lottie's `o`/`i` handles and CSS cubic-bezier take.
 * Absent = linear. */
export type Easing = [number, number, number, number];

/**
 * One keyframe of one property. `ease` is the curve OUT of this key and into
 * the next; `hold` steps instead of interpolating. Easing is per property,
 * not per moment — position and opacity on the same preset routinely want
 * different curves, which is why Lottie keys each property separately and so
 * does this.
 */
export interface PropertyKey<V> {
  t: number;
  v: V;
  ease?: Easing;
  hold?: boolean;
  /** Seconds this key may never fall later than. Normalized time stretches
   * with the element, which is right for a ramp and wrong for a hit: a punch
   * lands in a fifth of a second whether the line holds for one beat or six.
   * Only read when the caller knows the element's duration. */
  tMax?: number;
}

/**
 * The animated properties of a preset. Every one is optional; an absent
 * property simply does not move. Offsets are design px at the 1080 short
 * side, scales multiply, rotation is degrees clockwise, opacity multiplies
 * the element's own.
 */
export interface MotionProperties {
  /** Offset from the element's resting position. */
  position?: PropertyKey<[number, number]>[];
  /** Per-axis scale. A flip runs one axis through zero. */
  scale?: PropertyKey<[number, number]>[];
  rotation?: PropertyKey<number>[];
  opacity?: PropertyKey<number>[];
  /** How far the line spreads about its center — After Effects' tracking.
   * Each unit offsets by its own share, so the ends travel and the middle
   * holds. */
  tracking?: PropertyKey<number>[];
  /** Share of the box uncovered from its leading edge, 0..1 (wipes). */
  reveal?: PropertyKey<number>[];
  /** Share of the characters drawn, 0..1 (typewriter). */
  typed?: PropertyKey<number>[];
}

/** What the selector counts as one unit. */
export type SelectorBasis = "characters" | "charactersExcludingSpaces" | "words" | "lines";

/** How the hand-off is distributed across the units — After Effects' Shape. */
export type SelectorShape = "square" | "rampUp" | "rampDown" | "triangle" | "round" | "smooth";

/**
 * Which units are playing, and how far through, at a given moment. Present on
 * a preset = the motion runs unit by unit; absent = the element moves as one
 * piece.
 */
export interface RangeSelector {
  basedOn: SelectorBasis;
  shape: SelectorShape;
  /** Share of the window spent handing the motion from the first unit to the
   * last. 0 = every unit together; 1 = strictly one at a time. */
  spread: number;
  /** Eases the unit's own progress as it enters (`easeHigh`) and leaves
   * (`easeLow`) the selection, 0..1 — After Effects' Ease High / Ease Low. */
  easeHigh?: number;
  easeLow?: number;
  /** Deal the units their turn in a shuffled order rather than in reading
   * order — After Effects' Randomize Order. */
  randomize?: boolean;
  seed?: number;
}

/**
 * Per-unit random amplitude — After Effects' Wiggly Selector. The named
 * amounts are the maximum stray; each unit gets its own fixed draw from the
 * seed, so the same text always scatters the same way.
 */
export interface WigglySelector {
  position?: [number, number];
  rotation?: number;
  scale?: [number, number];
  seed?: number;
}

export type MotionSlot = "in" | "out" | "loop" | "hold";

export interface MotionPreset {
  label: string;
  /** What the move is for, in one line — the text the tool schemas and the
   * assistant's skills are written from. */
  note?: string;
  /** Where this preset may be used. */
  slots: MotionSlot[];
  /** Loops only: one cycle in seconds at speed 1. */
  period?: number;
  selector?: RangeSelector;
  wiggly?: WigglySelector;
  animate: MotionProperties;
  /** An exit that is not simply the entry played backwards. */
  animateOut?: MotionProperties;
}

export interface MotionCatalog {
  version: number;
  /** Entrances and exits, keyed by the id saved on an element. */
  edges: Record<string, MotionPreset>;
  /** Loops that run an element's whole duration. */
  loops: Record<string, MotionPreset>;
  /** Moves an element holds for its whole span, baked onto its own pose
   * track rather than played as a preset. */
  holds: Record<string, MotionPreset>;
}

/** A resolved pose for one unit at one moment. */
export interface MotionPose {
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  rotate: number;
  alpha: number;
  tracking: number;
  reveal?: number;
  typed?: number;
}

export const REST_POSE: MotionPose = {
  dx: 0,
  dy: 0,
  sx: 1,
  sy: 1,
  rotate: 0,
  alpha: 1,
  tracking: 0,
};
