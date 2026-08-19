/**
 * The one motion evaluator.
 *
 * Everything that moves in the app — entrances, exits, loops, hold moves and
 * the per-character sweeps — comes through here: sample a property's
 * keyframes at a normalized time, after a range selector has decided what
 * that time is for the unit being drawn. Nothing else computes motion.
 */

import {
  REST_POSE,
  type Easing,
  type MotionPose,
  type MotionPreset,
  type MotionProperties,
  type PropertyKey,
  type RangeSelector,
  type WigglySelector,
} from "./types";

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

/** A cubic bezier timing function, solved by bisection on x. Curves run
 * [0,0] to [1,1], the same handles Lottie writes and CSS reads. */
export function bezierEase(e: Easing, x: number): number {
  const [x1, y1, x2, y2] = e;
  const at = (a: number, b: number, t: number) =>
    3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (at(x1, x2, mid) < x) lo = mid;
    else hi = mid;
  }
  return at(y1, y2, (lo + hi) / 2);
}

/** One property's value at normalized time `q`: held before its first key and
 * after its last, eased between. */
export function sampleTrack<V extends number | [number, number]>(
  keys: PropertyKey<V>[] | undefined,
  q: number,
  rest: V
): V {
  if (!keys || keys.length === 0) return rest;
  const t = clamp01(q);
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1].t <= t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  if (a.hold) return a.v;
  const span = b.t - a.t;
  const raw = span > 0 ? (t - a.t) / span : 1;
  const p = a.ease ? bezierEase(a.ease, clamp01(raw)) : clamp01(raw);
  if (typeof a.v === "number") return lerp(a.v as number, b.v as number, p) as V;
  const av = a.v as [number, number];
  const bv = b.v as [number, number];
  return [lerp(av[0], bv[0], p), lerp(av[1], bv[1], p)] as V;
}

/** A track with its `tMax` caps resolved against a known duration. Keys stay
 * in order: a capped key drags the ones after it no earlier than itself. */
function capped<V extends number | [number, number]>(
  keys: PropertyKey<V>[] | undefined,
  dur: number
): PropertyKey<V>[] | undefined {
  if (!keys || dur <= 0 || !keys.some((k) => k.tMax !== undefined)) return keys;
  let floor = 0;
  return keys.map((k) => {
    const t = Math.max(floor, k.tMax === undefined ? k.t : Math.min(k.t, k.tMax / dur));
    floor = t;
    return { ...k, t };
  });
}

/** Every property of a preset sampled at one moment. `dur` resolves any
 * `tMax` caps; omit it and normalized time is used as written. */
export function sampleProperties(props: MotionProperties, q: number, dur = 0): MotionPose {
  if (dur > 0)
    props = {
      position: capped(props.position, dur),
      scale: capped(props.scale, dur),
      rotation: capped(props.rotation, dur),
      opacity: capped(props.opacity, dur),
      tracking: capped(props.tracking, dur),
      reveal: capped(props.reveal, dur),
      typed: capped(props.typed, dur),
    };
  return samplePropertiesRaw(props, q);
}

function samplePropertiesRaw(props: MotionProperties, q: number): MotionPose {
  const pos = sampleTrack(props.position, q, [0, 0] as [number, number]);
  const scale = sampleTrack(props.scale, q, [1, 1] as [number, number]);
  return {
    dx: pos[0],
    dy: pos[1],
    sx: scale[0],
    sy: scale[1],
    rotate: sampleTrack(props.rotation, q, 0),
    alpha: sampleTrack(props.opacity, q, 1),
    tracking: sampleTrack(props.tracking, q, 0),
    ...(props.reveal ? { reveal: sampleTrack(props.reveal, q, 1) } : {}),
    ...(props.typed ? { typed: sampleTrack(props.typed, q, 1) } : {}),
  };
}

/** A deterministic 0..1 draw for unit `i` of a seeded selector. */
function draw(seed: number, i: number, salt = 0): number {
  let h = (Math.imul(seed, 374761393) + Math.imul(i, 668265263) + Math.imul(salt, 2246822519)) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Where unit `i` sits in the hand-off order, 0 at the front. */
function orderOf(sel: RangeSelector, i: number, n: number): number {
  if (n <= 1) return 0;
  if (sel.randomize) {
    // Rank by the unit's own draw: a stable shuffle that needs no array.
    const mine = draw(sel.seed ?? 1, i);
    let rank = 0;
    for (let j = 0; j < n; j++) if (j !== i && draw(sel.seed ?? 1, j) < mine) rank++;
    return rank;
  }
  switch (sel.shape) {
    case "rampDown":
      return n - 1 - i;
    case "triangle": {
      // Both ends move first, meeting in the middle.
      const mid = (n - 1) / 2;
      return Math.round(mid - Math.abs(i - mid));
    }
    default:
      return i;
  }
}

/** The share of the window unit `i` starts at. `square` gives every unit its
 * own slot with no overlap; the ramps and curves overlap by `spread`. */
function startShare(sel: RangeSelector, i: number, n: number): number {
  if (n <= 1) return 0;
  const o = orderOf(sel, i, n);
  const spread = clamp01(sel.spread);
  if (sel.shape === "square") return o / n;
  const u = o / (n - 1);
  switch (sel.shape) {
    case "round":
      // Slow at the ends, quick through the middle.
      return (0.5 - Math.cos(u * Math.PI) / 2) * spread;
    case "smooth":
      return u * u * (3 - 2 * u) * spread;
    default:
      return u * spread;
  }
}

/**
 * Unit `i` of `n`'s own progress when its element's window stands at `p`.
 * This is the whole of what a range selector does: turn one clock into a
 * clock per character.
 */
export function selectorProgress(
  sel: RangeSelector,
  p: number,
  index: number,
  count: number,
  exiting = false
): number {
  const n = Math.max(1, count);
  // An exit sweeps out the way it came in, so the order reverses.
  const i = exiting ? n - 1 - index : index;
  const from = startShare(sel, i, n);
  const window = sel.shape === "square" ? 1 / n : Math.max(1e-6, 1 - clamp01(sel.spread));
  let q = clamp01((clamp01(p) - from) / window);
  if (sel.easeHigh) q = lerp(q, bezierEase([0.42, 0, 1, 1], q), clamp01(sel.easeHigh));
  if (sel.easeLow) q = lerp(q, bezierEase([0, 0, 0.58, 1], q), clamp01(sel.easeLow));
  return q;
}

/**
 * A looping selector hands each unit the same cycle at its own phase, so one
 * turn sweeps the whole line exactly once and the motion stays exactly
 * periodic — which is what lets a frame sequence render one cycle and repeat
 * it for as long as the element runs.
 */
export function loopProgress(
  sel: RangeSelector,
  p: number,
  index: number,
  count: number
): number {
  const n = Math.max(1, count);
  // The order — shuffled when the selector randomizes — is the phase offset,
  // so a run of one always sits at phase 0 and a whole element with no
  // characters plays the cycle exactly as written.
  const q = (p - (orderOf(sel, index, n) / n) * clamp01(sel.spread)) % 1;
  return q < 0 ? q + 1 : q;
}

/** The wiggly selector's fixed draw for one unit, applied on top of the pose.
 * `away` is how far from rest the unit still is, so the stray collapses to
 * nothing as the motion settles. */
function applyWiggly(pose: MotionPose, w: WigglySelector, index: number, away: number): MotionPose {
  const seed = w.seed ?? 7;
  const signed = (salt: number) => draw(seed, index, salt) * 2 - 1;
  const out = { ...pose };
  if (w.position) {
    out.dx += signed(1) * w.position[0] * away;
    out.dy += signed(2) * w.position[1] * away;
  }
  if (w.rotation) out.rotate += signed(3) * w.rotation * away;
  if (w.scale) {
    out.sx *= 1 + signed(4) * (w.scale[0] - 1) * away;
    out.sy *= 1 + signed(5) * (w.scale[1] - 1) * away;
  }
  return out;
}

/**
 * A preset's pose for one unit at window position `p`.
 *
 * `index`/`count` place the unit in its run; an element moving as one piece is
 * unit 0 of 1. `exiting` picks the exit track and reverses the sweep.
 */
export function evalPreset(
  preset: MotionPreset,
  p: number,
  index = 0,
  count = 1,
  exiting = false,
  dur = 0
): MotionPose {
  const props = exiting && preset.animateOut ? preset.animateOut : preset.animate;
  const q = !preset.selector
    ? clamp01(p)
    : preset.period !== undefined
      ? loopProgress(preset.selector, p, index, count)
      : selectorProgress(preset.selector, p, index, count, exiting);
  const pose = sampleProperties(props, q, dur);
  return preset.wiggly ? applyWiggly(pose, preset.wiggly, index, 1 - q) : pose;
}

/**
 * A preset's pose for the element as ONE piece, ignoring any selector: the
 * whole box plays the motion once over the window. This is what a renderer
 * with a single cached picture draws, and what every non-text kind gets from
 * a per-character style.
 */
export function evalWhole(
  preset: MotionPreset,
  p: number,
  exiting = false,
  dur = 0
): MotionPose {
  const props = exiting && preset.animateOut ? preset.animateOut : preset.animate;
  const q = clamp01(p);
  const pose = sampleProperties(props, q, dur);
  // A wiggly preset keeps its stray here too — it is the whole motion of a
  // scatter, and dropping it would leave the element with only its fade.
  return preset.wiggly ? applyWiggly(pose, preset.wiggly, 0, 1 - q) : pose;
}

/** How far a preset ever strays from rest, in design px, and whether it turns.
 * Read from the data, so a new preset never has to be registered anywhere for
 * the frame sampler to pad its crop correctly. */
export function presetExtent(preset: MotionPreset): { travel: number; rotates: boolean } {
  let travel = 0;
  let rotates = false;
  for (const props of [preset.animate, preset.animateOut]) {
    if (!props) continue;
    // A unit carries both: the whole line's offset, plus its own share of the
    // spread, so the one that gets farthest gets the sum of the two.
    let offset = 0;
    let spread = 0;
    for (const k of props.position ?? [])
      offset = Math.max(offset, Math.abs(k.v[0]), Math.abs(k.v[1]));
    for (const k of props.tracking ?? []) spread = Math.max(spread, Math.abs(k.v));
    travel = Math.max(travel, offset + spread);
    if ((props.rotation ?? []).some((k) => k.v !== 0)) rotates = true;
  }
  if (preset.wiggly?.position)
    travel += Math.max(preset.wiggly.position[0], preset.wiggly.position[1]);
  if (preset.wiggly?.rotation) rotates = true;
  return { travel, rotates };
}

export { REST_POSE };
