/**
 * Keyframes: the power tier over the In / Out / Loop presets.
 *
 * A key is a whole pose — position, scale, rotation, opacity — captured at a
 * moment inside the element. Between keys the pose moves linearly; before the
 * first and after the last it holds. An element with no keys poses at its own
 * resting fields, so keyframes are strictly additive: nothing changes until a
 * key exists.
 *
 * Presets still compose on top. The preset transform is read as an offset —
 * travel, scale multiplier, extra rotation, alpha multiplier — so a title can
 * fade in, drift along a keyframed path, and pulse, all at once. `evalOverlayFrame`
 * is the one function that folds the two together, and every renderer calls
 * it: the DOM preview, the in-tab canvas export, the behind-speaker pass, and
 * the frame sampler that feeds ffmpeg.
 */

import { evalOverlayAnim, hasOverlayAnim, type OverlayAnim } from "./anim";

/** A pose captured at `t` seconds into the element. Values are absolute, in
 * the same units as the element's own fields — `scale` multiplies the
 * element's intrinsic size, where 1 is the size it was drawn at. */
export interface OverlayKey {
  t: number;
  x: number; // center, fraction of frame width
  y: number; // center, fraction of frame height
  scale: number;
  rotation: number; // degrees clockwise
  opacity: number; // 0..1
}

/** What an element looks like at one moment, before presets compose over it. */
export interface OverlayPose {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
}

/** The fields `evalOverlayFrame` reads — every overlay kind has them. The
 * mask is read structurally (keyed or not), keeping this module free of the
 * mask model. */
interface Posable {
  start: number;
  end: number;
  x: number;
  y: number;
  rotation?: number;
  opacity?: number;
  anim?: OverlayAnim;
  kf?: OverlayKey[];
  mask?: { kf?: { t: number }[] };
}

/** Two keys closer than this are the same key. Half a frame at 30fps, so a
 * key can be dropped on any frame and still replace the one already there. */
export const KEY_EPSILON = 1 / 60;

/** The element's pose with no keys in play. */
export function restingPose(o: Posable): OverlayPose {
  return {
    x: o.x,
    y: o.y,
    scale: 1,
    rotation: o.rotation ?? 0,
    opacity: o.opacity ?? 1,
  };
}

/** Whether the element carries keys worth evaluating. */
export function hasOverlayKeys(o: Posable): boolean {
  return !!o.kf && o.kf.length > 0;
}

/** Whether anything about the element moves — a preset, pose keys, or a
 * keyframed mask. An element that does not move renders as one still
 * picture. */
export function isOverlayAnimated(o: Posable): boolean {
  return hasOverlayAnim(o.anim) || hasOverlayKeys(o) || !!(o.mask?.kf && o.mask.kf.length > 0);
}

/** Keys in play order. Callers may hand them over unsorted (a key added at the
 * playhead lands wherever the user was). */
export function sortedKeys<K extends { t: number }>(keys: K[]): K[] {
  return [...keys].sort((a, b) => a.t - b.t);
}

/**
 * The interpolation core every key track shares: find the surrounding keys,
 * hold flat outside them, and hand the pair to `mix`. The pose track and the
 * mask track are both thin wrappers over this.
 */
export function lerpKeys<K extends { t: number }>(
  keys: K[],
  tLocal: number,
  mix: (a: K, b: K, p: number) => K
): K {
  const ks = sortedKeys(keys);
  if (tLocal <= ks[0].t) return ks[0];
  const last = ks[ks.length - 1];
  if (tLocal >= last.t) return last;
  let i = 0;
  while (i < ks.length - 1 && ks[i + 1].t <= tLocal) i++;
  const a = ks[i];
  const b = ks[i + 1];
  const span = b.t - a.t;
  const p = span > 1e-6 ? (tLocal - a.t) / span : 0;
  return mix(a, b, p);
}

/** The pose at `tLocal` seconds into the element: interpolated between the
 * surrounding keys, held flat outside them, resting when there are no keys. */
export function poseAt(o: Posable, tLocal: number): OverlayPose {
  const keys = o.kf;
  if (!keys || keys.length === 0) return restingPose(o);
  const k = lerpKeys(keys, tLocal, (a, b, p) => {
    const mix = (u: number, v: number) => u + (v - u) * p;
    return {
      t: mix(a.t, b.t),
      x: mix(a.x, b.x),
      y: mix(a.y, b.y),
      scale: mix(a.scale, b.scale),
      // Rotation takes the short way around, so a key at 350° into one at 10°
      // turns 20° forward instead of 340° back.
      rotation: a.rotation + shortestTurn(a.rotation, b.rotation) * p,
      opacity: mix(a.opacity, b.opacity),
    };
  });
  return poseOf(k);
}

/** The signed short-way-around turn from one angle to another, degrees. */
export function shortestTurn(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

function poseOf(k: OverlayKey): OverlayPose {
  return { x: k.x, y: k.y, scale: k.scale, rotation: k.rotation, opacity: k.opacity };
}

/** A key holding the element's pose at `t`, ready to be added. Capturing the
 * live pose is what makes the first two keys a no-op: the element sits where
 * it already sat until one of them is moved. */
export function keyAt(o: Posable, t: number): OverlayKey {
  return { t, ...poseAt(o, t) };
}

/** Insert or replace a key, keeping the list in play order. A key dropped on
 * top of an existing one (within `KEY_EPSILON`) replaces it. */
export function upsertKey<K extends { t: number }>(keys: K[] | undefined, key: K): K[] {
  const rest = (keys ?? []).filter((k) => Math.abs(k.t - key.t) > KEY_EPSILON);
  return sortedKeys([...rest, key]);
}

/** Drop the key at `t`, or return the list unchanged when none sits there. */
export function removeKeyAt<K extends { t: number }>(keys: K[] | undefined, t: number): K[] {
  return (keys ?? []).filter((k) => Math.abs(k.t - t) > KEY_EPSILON);
}

/** The key sitting at `t`, if there is one. */
export function keyIndexAt(keys: { t: number }[] | undefined, t: number): number {
  return (keys ?? []).findIndex((k) => Math.abs(k.t - t) <= KEY_EPSILON);
}

/** The element's full frame state: the keyframed pose with the preset
 * animation composed over it. `dx`/`dy` are the preset's travel in design px
 * (1080 short side); the pose's `x`/`y` stay fractions of the frame, because
 * that is what keeps an element in the same place at any aspect.
 */
export interface OverlayFrameState extends OverlayPose {
  dx: number;
  dy: number;
  /** 0..1 share of the text shown (typewriter); absent when not typing. */
  textProgress?: number;
}

export function evalOverlayFrame(o: Posable, tLocal: number): OverlayFrameState {
  const dur = Math.max(0.1, o.end - o.start);
  const pose = poseAt(o, tLocal);
  const ev = evalOverlayAnim(o.anim, tLocal, dur);
  return {
    x: pose.x,
    y: pose.y,
    dx: ev.dx,
    dy: ev.dy,
    scale: pose.scale * ev.scale,
    rotation: pose.rotation + ev.rotate,
    opacity: pose.opacity * ev.alpha,
    ...(ev.textProgress !== undefined ? { textProgress: ev.textProgress } : {}),
  };
}

/** The corners of the box the pose sweeps through, as fractions of the frame,
 * plus the largest scale it reaches. The frame sampler crops to this, so a
 * keyframed element's pictures stay small even when it crosses the screen. */
export function poseExtent(o: Posable): {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  scale: number;
} {
  const poses = hasOverlayKeys(o) ? sortedKeys(o.kf!).map(poseOf) : [restingPose(o)];
  return {
    x0: Math.min(...poses.map((p) => p.x)),
    y0: Math.min(...poses.map((p) => p.y)),
    x1: Math.max(...poses.map((p) => p.x)),
    y1: Math.max(...poses.map((p) => p.y)),
    scale: Math.max(...poses.map((p) => p.scale), 1),
  };
}
