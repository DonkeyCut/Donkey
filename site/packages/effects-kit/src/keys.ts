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

import {
  evalOverlayAnim,
  hasOverlayAnim,
  type GlyphLoopPhase,
  type GlyphPhase,
  type OverlayAnim,
} from "./anim";
import {
  capStreak,
  composeCamera,
  designFrame,
  hasCameraKeys,
  MOTION_BLUR_FRAME,
  REST_CAMERA,
  type CameraKey,
  type CameraPose,
  type GroupCamera,
} from "./camera";
import { easeAt, type EaseId } from "./ease";
import { splitScale } from "./stretch";
import { dealsMarks, type ShapeKind } from "./types";

/** A pose captured at `t` seconds into the element. Values are absolute, in
 * the same units as the element's own fields — `scale` multiplies the
 * element's intrinsic size, where 1 is the size it was drawn at. */
export interface OverlayKey {
  t: number;
  x: number; // center, fraction of frame width
  y: number; // center, fraction of frame height
  scale: number;
  /** Width and height over `scale`; absent = 1. A screen switching off
   * squashes scaleY toward 0. */
  scaleX?: number;
  scaleY?: number;
  rotation: number; // degrees clockwise
  /** 3D tilt in degrees, seen in perspective (TILT_PERSPECTIVE): tiltX turns
   * the element about its horizontal axis, top edge away from the viewer;
   * tiltY about its vertical axis, right edge away. Absent = flat. */
  tiltX?: number;
  tiltY?: number;
  opacity: number; // 0..1
  /** Gaussian blur, px at the 1080 short side; absent = the element's own. */
  blur?: number;
  /** The curve out of this key into the next; absent = constant rate. */
  ease?: EaseId;
}

/** How far the viewer sits from a tilted element, px at the 1080 design
 * short side: the CSS perspective() the DOM draws with and the depth the
 * canvas painters project through. */
export const TILT_PERSPECTIVE = 1600;

/** The steepest tilt a key holds, degrees either way: at 90 the element is
 * edge-on and gone. */
export const TILT_MAX = 85;

/** The most a tilt can grow an element's nearer edge, for the frame sampler's
 * crop: an edge 540 design px off center tipped fully toward the viewer. */
export const TILT_GROW = TILT_PERSPECTIVE / (TILT_PERSPECTIVE - 540);

/** What an element looks like at one moment, before presets compose over it. */
export interface OverlayPose {
  x: number;
  y: number;
  /** The larger axis; `sx`/`sy` stretch each axis over it (see stretch.ts). */
  scale: number;
  sx?: number;
  sy?: number;
  rotation: number;
  /** Absent = flat (see OverlayKey). */
  tiltX?: number;
  tiltY?: number;
  opacity: number;
  /** Absent = sharp. */
  blur?: number;
}

/** The fields `evalOverlayFrame` reads — every overlay kind has them. The
 * mask is read structurally (keyed or not), keeping this module free of the
 * mask model. */
interface Posable {
  start: number;
  end: number;
  x: number;
  y: number;
  /** Absent means text — the union's own default. Only the per-glyph styles
   * read it, to decide whether there are glyphs to move. */
  kind?: string;
  /** A shape's kind; a doodle paints anew on every beat. */
  shape?: ShapeKind;
  rotation?: number;
  opacity?: number;
  anim?: OverlayAnim;
  kf?: OverlayKey[];
  mask?: { kf?: { t: number }[] };
  blur?: number;
  motionBlur?: number;
  camera?: GroupCamera;
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
    ...(o.blur ? { blur: o.blur } : {}),
  };
}

/** Whether the element carries keys worth evaluating. */
export function hasOverlayKeys(o: Posable): boolean {
  return !!o.kf && o.kf.length > 0;
}

/** Whether the element is drawn through the per-frame evaluator: something
 * moves it (a preset, pose keys, its group's camera, a keyframed mask) or it
 * paints anew on every beat (a doodle). Any other element renders as one
 * still picture, its own blur baked in. */
export function isOverlayAnimated(o: Posable): boolean {
  return (
    (o.kind === "shape" && !!o.shape && dealsMarks(o.shape)) ||
    hasOverlayAnim(o.anim) ||
    hasOverlayKeys(o) ||
    hasCameraKeys(o.camera) ||
    !!(o.mask?.kf && o.mask.kf.length > 0)
  );
}

/** Keys in play order. Callers may hand them over unsorted (a key added at the
 * playhead lands wherever the user was). */
export function sortedKeys<K extends { t: number }>(keys: K[]): K[] {
  return [...keys].sort((a, b) => a.t - b.t);
}

/** Each stored track in play order, sorted once: a track is replaced on
 * every edit and never changed in place, so a tracked mask's key per frame
 * costs one sort when it lands and nothing on the frames that read it. */
const playOrder = new WeakMap<object, { t: number }[]>();

/**
 * The interpolation core every key track shares: find the surrounding keys,
 * hold flat outside them, and hand the pair to `mix`. The pose track and the
 * mask track are both thin wrappers over this.
 */
export function lerpKeys<K extends { t: number; ease?: EaseId }>(
  keys: K[],
  tLocal: number,
  mix: (a: K, b: K, p: number) => K
): K {
  let ks = playOrder.get(keys) as K[] | undefined;
  if (!ks) {
    ks = sortedKeys(keys);
    playOrder.set(keys, ks);
  }
  if (tLocal <= ks[0].t) return ks[0];
  const last = ks[ks.length - 1];
  if (tLocal >= last.t) return last;
  let lo = 0;
  let hi = ks.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ks[mid].t <= tLocal) lo = mid;
    else hi = mid;
  }
  const i = lo;
  const a = ks[i];
  const b = ks[i + 1];
  const span = b.t - a.t;
  const p = span > 1e-6 ? (tLocal - a.t) / span : 0;
  // The first key's curve carries the move out of it into the next.
  return mix(a, b, a.ease ? easeAt(a.ease, p) : p);
}

/** The pose at `tLocal` seconds into the element: interpolated between the
 * surrounding keys, held flat outside them, resting when there are no keys. */
export function poseAt(o: Posable, tLocal: number): OverlayPose {
  if (!hasOverlayKeys(o)) return restingPose(o);
  return poseOf(trackAt(o.kf!, tLocal, o.blur ?? 0), o.blur ?? 0);
}

/** The pose at `tLocal` in the keys' own terms (a uniform scale with its
 * per-axis stretch apart), the way an editor shows and writes it. */
export function keyPoseAt(o: Posable, tLocal: number): Omit<OverlayKey, "t" | "ease"> {
  if (!hasOverlayKeys(o)) return restingPose(o);
  const k: Partial<OverlayKey> = { ...trackAt(o.kf!, tLocal, o.blur ?? 0) };
  delete k.t;
  delete k.ease;
  return k as Omit<OverlayKey, "t" | "ease">;
}

/** The key track interpolated at `tLocal`. */
function trackAt(keys: OverlayKey[], tLocal: number, rest: number): OverlayKey {
  // A key with no blur of its own takes the element's.
  return lerpKeys(keys, tLocal, (a, b, p) => {
    const mix = (u: number, v: number) => u + (v - u) * p;
    const blur = mix(a.blur ?? rest, b.blur ?? rest);
    // Axes and tilts a key leaves out sit at rest, so a squash or a tilt on
    // one key eases in from the key before it.
    const scaleX = mix(a.scaleX ?? 1, b.scaleX ?? 1);
    const scaleY = mix(a.scaleY ?? 1, b.scaleY ?? 1);
    const tiltX = mix(a.tiltX ?? 0, b.tiltX ?? 0);
    const tiltY = mix(a.tiltY ?? 0, b.tiltY ?? 0);
    return {
      t: mix(a.t, b.t),
      x: mix(a.x, b.x),
      y: mix(a.y, b.y),
      scale: mix(a.scale, b.scale),
      ...(scaleX !== 1 ? { scaleX } : {}),
      ...(scaleY !== 1 ? { scaleY } : {}),
      // Rotation takes the short way around, so a key at 350° into one at 10°
      // turns 20° forward instead of 340° back.
      rotation: a.rotation + shortestTurn(a.rotation, b.rotation) * p,
      ...(tiltX !== 0 ? { tiltX } : {}),
      ...(tiltY !== 0 ? { tiltY } : {}),
      opacity: mix(a.opacity, b.opacity),
      ...(blur > 0 ? { blur } : {}),
    };
  });
}

/** The signed short-way-around turn from one angle to another, degrees. */
export function shortestTurn(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

function poseOf(k: OverlayKey, restBlur = 0): OverlayPose {
  const blur = k.blur ?? restBlur;
  return {
    x: k.x,
    y: k.y,
    ...splitScale(k.scale * (k.scaleX ?? 1), k.scale * (k.scaleY ?? 1)),
    rotation: k.rotation,
    ...(k.tiltX ? { tiltX: k.tiltX } : {}),
    ...(k.tiltY ? { tiltY: k.tiltY } : {}),
    opacity: k.opacity,
    ...(blur > 0 ? { blur } : {}),
  };
}

/** A key holding the element's pose at `t`, ready to be added. Capturing the
 * live pose is what makes the first two keys a no-op: the element sits where
 * it already sat until one of them is moved. */
export function keyAt(o: Posable, t: number): OverlayKey {
  return { t, ...keyPoseAt(o, t) };
}

/** The camera's pose at `tLocal` seconds into the element: eased between the
 * surrounding keys, held outside them. Zoom moves by ratio, so a push from 1×
 * to 4× feels as even as one from 2× to 8×. */
export function cameraAt(cam: GroupCamera | undefined, tLocal: number): CameraPose {
  if (!hasCameraKeys(cam)) return REST_CAMERA;
  const k = lerpKeys<CameraKey>(cam.kf, tLocal, (a, b, p) => {
    const mix = (u: number, v: number) => u + (v - u) * p;
    const sa = Math.max(1e-3, a.scale);
    const sb = Math.max(1e-3, b.scale);
    return {
      t: mix(a.t, b.t),
      x: mix(a.x, b.x),
      y: mix(a.y, b.y),
      scale: sa * Math.pow(sb / sa, p),
      rotation: a.rotation + shortestTurn(a.rotation, b.rotation) * p,
    };
  });
  return { x: k.x, y: k.y, scale: k.scale, rotation: k.rotation };
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
  /** 0..1 share of its value each number shows (count); absent when not
   * counting. */
  countProgress?: number;
  /** 0..1 share of the box uncovered from its left edge (wipe). */
  reveal?: number;
  /** 0..1 share of the ink eaten away (disintegrate). */
  erode?: number;
  /** 0..1 strength of the electric arcs over the element (zap hit). */
  zap?: number;
  /** Where a per-glyph ramp stands; the element's own transform stays neutral
   * and each character carries the motion. */
  glyphs?: GlyphPhase;
  /** Where a per-glyph loop stands, on the same terms. */
  glyphLoop?: GlyphLoopPhase;
  /** How far the view has flown into the element's deepest ink (dive). */
  dive?: number;
  /** The motion blur streak: how far the element's center travels on screen
   * while the shutter is open, design px, centered on this moment. Absent
   * when motion blur is off or the element is still. */
  streak?: { x: number; y: number };
  /** Whether the typing bar is lit; absent when the element has none. */
  caret?: boolean;
  /** Multiplies the element's colors (a hit that darkens); absent = 1. */
  brightness?: number;
}

/**
 * The element's frame state at `tLocal`, as every renderer draws it: the
 * pose, the presets over it, its group's camera over both, and the motion
 * blur streak. `aspect` (frame width / height) is required once a camera or
 * motion blur is in play, since both work in on-screen distances.
 */
export function evalOverlayFrame(o: Posable, tLocal: number, aspect?: number): OverlayFrameState {
  const own = ownFrame(o, tLocal);
  const cam = hasCameraKeys(o.camera) ? o.camera : undefined;
  const shutter = o.motionBlur || cam?.motionBlur || 0;
  if (!cam && !shutter) return own;
  if (!aspect || !Number.isFinite(aspect)) {
    throw new Error("A camera or motion blur needs the frame's aspect to evaluate.");
  }
  const placed = cam ? composeCamera(own, cameraAt(cam, tLocal), aspect) : own;
  if (!shutter) return placed;
  // The element's own motion blur streaks its whole move on screen; the
  // camera's streaks only what the camera does, with the element held still.
  const whole = !!o.motionBlur;
  const exposure = shutter * MOTION_BLUR_FRAME;
  const dur = Math.max(0.1, o.end - o.start);
  const t0 = Math.max(0, tLocal - exposure / 2);
  const t1 = Math.min(dur, tLocal + exposure / 2);
  if (t1 - t0 < 1e-6) return placed;
  const at = (t: number) => {
    const s = whole ? ownFrame(o, t) : own;
    return cam ? composeCamera(s, cameraAt(cam, t), aspect) : s;
  };
  const a = at(t0);
  const b = at(t1);
  const f = designFrame(aspect);
  // Velocity over the window that fits inside the element, scaled to the
  // whole exposure, so the first and last frames streak like the rest.
  const k = exposure / (t1 - t0);
  const streak = capStreak(
    ((b.x - a.x) * f.width + (b.dx - a.dx)) * k,
    ((b.y - a.y) * f.height + (b.dy - a.dy)) * k,
    shutter
  );
  return streak ? { ...placed, streak } : placed;
}

/** The element's own frame state: its pose with the presets over it. */
function ownFrame(o: Posable, tLocal: number): OverlayFrameState {
  const dur = Math.max(0.1, o.end - o.start);
  const pose = poseAt(o, tLocal);
  const ev = evalOverlayAnim(o.anim, tLocal, dur, (o.kind ?? "text") === "text");
  // The pose's axes and the preset's multiply axis by axis, so a key squash
  // and a preset flip compose.
  const size = splitScale(
    pose.scale * (pose.sx ?? 1) * ev.scale * (ev.sx ?? 1),
    pose.scale * (pose.sy ?? 1) * ev.scale * (ev.sy ?? 1)
  );
  return {
    x: pose.x,
    y: pose.y,
    dx: ev.dx,
    dy: ev.dy,
    ...size,
    rotation: pose.rotation + ev.rotate,
    ...(pose.tiltX ? { tiltX: pose.tiltX } : {}),
    ...(pose.tiltY ? { tiltY: pose.tiltY } : {}),
    opacity: pose.opacity * ev.alpha,
    ...(ev.textProgress !== undefined ? { textProgress: ev.textProgress } : {}),
    ...(ev.countProgress !== undefined ? { countProgress: ev.countProgress } : {}),
    ...(ev.reveal !== undefined ? { reveal: ev.reveal } : {}),
    ...(ev.erode !== undefined ? { erode: ev.erode } : {}),
    ...(ev.zap ? { zap: ev.zap } : {}),
    ...(ev.glyphs ? { glyphs: ev.glyphs } : {}),
    ...(ev.glyphLoop ? { glyphLoop: ev.glyphLoop } : {}),
    ...(ev.dive !== undefined ? { dive: ev.dive } : {}),
    ...(pose.blur || ev.blur ? { blur: (pose.blur ?? 0) + (ev.blur ?? 0) } : {}),
    ...(ev.caret !== undefined ? { caret: ev.caret } : {}),
    ...(ev.brightness !== undefined ? { brightness: ev.brightness } : {}),
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
  const poses = hasOverlayKeys(o) ? sortedKeys(o.kf!).map((k) => poseOf(k)) : [restingPose(o)];
  // A tilted edge swings toward the viewer and draws larger than its scale.
  const tilted = poses.some((p) => p.tiltX || p.tiltY);
  return {
    x0: Math.min(...poses.map((p) => p.x)),
    y0: Math.min(...poses.map((p) => p.y)),
    x1: Math.max(...poses.map((p) => p.x)),
    y1: Math.max(...poses.map((p) => p.y)),
    scale: Math.max(...poses.map((p) => p.scale), 1) * (tilted ? TILT_GROW : 1),
  };
}
