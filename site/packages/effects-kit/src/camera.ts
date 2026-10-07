/**
 * A camera over a world of elements, and the blur that comes with moving it.
 *
 * Explainer graphics are often a set of cards laid out like a board, with a
 * camera gliding over them: it steps from one card to the next, pushes onto
 * the one being talked about, pulls back. Moving every card's own keys to fake
 * that is a lot of bookkeeping, and the cards drift apart the moment one key
 * is off. So a group carries one camera pose track, and every element in the
 * group is drawn through it — the cards keep their own places and poses, and
 * the camera moves the whole board as one.
 *
 * A camera pose names the world point that sits at the frame's center (`x`,
 * `y`, fractions of the frame, like an element's position), how far the view
 * is zoomed in (`scale`, 2 shows the world twice as large), and how far the
 * world is turned clockwise about the frame's center (`rotation`, degrees).
 * The camera at rest — centered, unzoomed, level — changes nothing.
 *
 * Every member stores the same camera, with key times in seconds from its own
 * start like its pose keys, so the camera travels with the group when it is
 * moved on the timeline and every renderer reads it off the element alone.
 */

import type { EaseId } from "./ease";

/** A camera pose at `t` seconds into the element. `ease` is the curve out of
 * this key into the next. */
export interface CameraKey {
  t: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  ease?: EaseId;
}

/** A group's camera, as each member carries it. `motionBlur` streaks what the
 * camera's movement does to the picture (shutter, 0..1; absent = off). */
export interface GroupCamera {
  kf: CameraKey[];
  motionBlur?: number;
}

export interface CameraPose {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

export const REST_CAMERA: CameraPose = { x: 0.5, y: 0.5, scale: 1, rotation: 0 };

/** The world a group's camera films, in frame fractions: the frame and one
 * frame beyond each edge. Its look-at point and its members sit inside it. */
export const CAMERA_WORLD_MIN = -1;
export const CAMERA_WORLD_MAX = 2;

/** How far the camera may pull back and push in. */
export const CAMERA_SCALE_MIN = 0.25;
export const CAMERA_SCALE_MAX = 8;

/** The softest an element may be, design px at the 1080 short side. */
export const ELEMENT_BLUR_MAX = 60;

/** Whether the camera has any keys to move by. */
export function hasCameraKeys(cam: GroupCamera | undefined): cam is GroupCamera {
  return !!cam && cam.kf.length > 0;
}

/**
 * Where a world point lands on screen under the camera. Positions are frame
 * fractions; the turn happens in a square space (x scaled by the aspect), so
 * the board turns rigidly on a frame of any shape.
 */
export function cameraPoint(
  cam: CameraPose,
  x: number,
  y: number,
  aspect: number
): { x: number; y: number } {
  const v = cameraVector(cam, (x - cam.x) * aspect, y - cam.y);
  return { x: 0.5 + v.x / aspect, y: 0.5 + v.y };
}

/** A world-space offset (any unit, same on both axes) as seen on screen: the
 * camera's zoom and turn, without its travel. */
export function cameraVector(cam: CameraPose, dx: number, dy: number): { x: number; y: number } {
  const r = (cam.rotation * Math.PI) / 180;
  const c = Math.cos(r) * cam.scale;
  const s = Math.sin(r) * cam.scale;
  return { x: c * dx - s * dy, y: s * dx + c * dy };
}

/** The world point that shows at a screen point: the inverse of
 * `cameraPoint`. A drag in the preview moves an element by this. */
export function worldPoint(
  cam: CameraPose,
  x: number,
  y: number,
  aspect: number
): { x: number; y: number } {
  const v = worldVector(cam, (x - 0.5) * aspect, y - 0.5);
  return { x: cam.x + v.x / aspect, y: cam.y + v.y };
}

/** A screen-space offset as a world-space one: `cameraVector` through the
 * inverse pose (the turn undone, the zoom inverted). */
function worldVector(cam: CameraPose, dx: number, dy: number): { x: number; y: number } {
  return cameraVector({ ...cam, rotation: -cam.rotation, scale: 1 / Math.max(1e-6, cam.scale) }, dx, dy);
}

/**
 * An element's frame state seen through the camera: its center moves to
 * where the camera shows it, the preset's travel turns and grows with the
 * world, and the camera's zoom and turn add to the element's own.
 */
export function composeCamera<
  S extends { x: number; y: number; dx: number; dy: number; scale: number; rotation: number },
>(state: S, cam: CameraPose, aspect: number): S {
  const p = cameraPoint(cam, state.x, state.y, aspect);
  const d = cameraVector(cam, state.dx, state.dy);
  return {
    ...state,
    x: p.x,
    y: p.y,
    dx: d.x,
    dy: d.y,
    scale: state.scale * cam.scale,
    rotation: state.rotation + cam.rotation,
  };
}

/** The camera with every key moved `by` seconds — what keeps a member on the
 * group's clock when its own start moves under it (a left trim, a split). */
export function shiftCamera(cam: GroupCamera, by: number): GroupCamera {
  return { ...cam, kf: cam.kf.map((k) => ({ ...k, t: Math.round((k.t + by) * 1000) / 1000 })) };
}

// --- Motion blur ---------------------------------------------------------
//
// A real shutter stays open for part of each frame, so anything that moves
// while it is open smears along its path. Here the exposure is a share of a
// 30fps frame — 0.5 is the classic half-open shutter — and the smear is the
// distance the element's center travels on screen while it is open. The
// exposure is measured in seconds, so a 24fps export, a 60fps export and the
// preview all draw the same streak for the same move. A still frame travels
// nowhere and stays sharp.

/** The frame the shutter amount is a share of, seconds. */
export const MOTION_BLUR_FRAME = 1 / 30;
/** A streak shorter than this, design px, draws nothing: the frame is sharp. */
export const STREAK_MIN = 0.75;
/** The longest streak, design px. A whip faster than this reads as a blur
 * either way, and the cap bounds what a frame costs to draw. */
export const STREAK_MAX = 96;
/** Design px between two taps along a streak. */
const STREAK_TAP_SPACING = 4;
/** The most copies one streak is drawn from. */
export const STREAK_TAPS_MAX = 24;

/** The streak for a screen displacement over the exposure (design px): the
 * displacement itself, capped in length, or null when it is too short to see. */
export function capStreak(dx: number, dy: number): { x: number; y: number } | null {
  const len = Math.hypot(dx, dy);
  if (!(len >= STREAK_MIN)) return null;
  const k = len > STREAK_MAX ? STREAK_MAX / len : 1;
  return { x: dx * k, y: dy * k };
}

/** How many copies a streak of `len` design px is drawn from: enough that
 * neighbours sit a few pixels apart, never fewer than two. Counted in design
 * px so a preview and a 4K export split the same streak the same way. */
export function streakTaps(len: number): number {
  if (!(len >= STREAK_MIN)) return 0;
  return Math.max(2, Math.min(STREAK_TAPS_MAX, Math.ceil(len / STREAK_TAP_SPACING) + 1));
}

/** Design px of frame for an aspect (width / height), short side 1080. */
export function designFrame(aspect: number): { width: number; height: number } {
  return aspect >= 1 ? { width: 1080 * aspect, height: 1080 } : { width: 1080, height: 1080 / aspect };
}
