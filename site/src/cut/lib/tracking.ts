"use client";

/**
 * Motion tracking: MediaPipe's hand, face and pose landmarkers read a clip's
 * footage frame by frame and report where a target sits in each one — its
 * outline, its center, and an axis that carries its turn and size.
 *
 * The landmarkers run in VIDEO mode, so each frame seeds the next and a
 * target is followed rather than re-found. Frames decode in source order
 * whichever way the clip plays, which is the order the trackers expect. Every
 * coordinate comes back in the source picture's own 0..1 space; placing it in
 * the project frame is trackKeys.ts's job. The models are self-hosted and the
 * task closes when the read ends.
 */

import type { FaceLandmarker, HandLandmarker, NormalizedLandmark, PoseLandmarker } from "@mediapipe/tasks-vision";
import { cutTracking } from "./chatRuntime";
import { framesAt } from "./mediaRead";
import { visionFileset, withQuietWasmLogs } from "./mediapipe";
import { trackTargetOf, type TrackTarget } from "./trackTargets";
import type { MaskPoint } from "@donkeycut/effects-kit";
import type { TrackSample } from "./trackKeys";

const HAND_MODEL = "/mediapipe/hand_landmarker.task";
const FACE_MODEL = "/mediapipe/face_landmarker.task";
const POSE_MODEL = "/mediapipe/pose_landmarker_full.task";

/** Hand landmark indices (MediaPipe hand model). */
const HAND = { wrist: 0, thumbTip: 4, indexMcp: 5, indexTip: 8, middleMcp: 9, ringMcp: 13, pinkyMcp: 17 };
/** Face mesh indices for the outer eye corners: the head's roll and size. */
const FACE = { rightEyeOuter: 33, leftEyeOuter: 263 };
/** Pose landmark indices for the torso. */
const POSE = { leftShoulder: 11, rightShoulder: 12, leftHip: 23, rightHip: 24 };

/** Faces and bodies a frame may hold; the track keeps the one it started on. */
const MAX_PEOPLE = 4;
/** A pose landmark counts once the model is this sure it is in view. */
const POSE_VISIBLE = 0.5;
/** Corners in a hand or body outline: the hull, resampled around its center
 * so every frame's outline has the same corners to blend between. */
const RING_POINTS = 24;
/** How far, in picture fractions, a target may move between two frames and
 * still be the same one. */
const SAME_TARGET = 0.25;

type Landmarks = NormalizedLandmark[];
type Detector = { detect: (frame: TexImageSource, ms: number) => Landmarks[]; close: () => void };

/**
 * Track `target` through `src` at the given source seconds. Returns one sample
 * per time, in the order asked, null where the target was not found.
 * `onFrame` reports progress as frames are read.
 */
export async function trackFootage(
  src: string,
  size: { width: number; height: number },
  target: TrackTarget,
  times: number[],
  onFrame?: (done: number, total: number) => void
): Promise<(TrackSample | null)[]> {
  const settings = cutTracking();

  // Decode at the configured long side, keeping the picture's own aspect.
  const long = Math.max(size.width, size.height);
  const k = Math.min(1, settings.longSide / Math.max(1, long));
  const read = size.width >= size.height ? { width: Math.round(size.width * k) } : { height: Math.round(size.height * k) };

  // Source order: one forward decode pass, and the order the tracker follows.
  const order = times.map((_, i) => i).sort((a, b) => times[a] - times[b]);
  const out: (TrackSample | null)[] = times.map(() => null);
  const detector = await openDetector(target, settings.minConfidence);
  let prev: MaskPoint | null = null;
  let seen = 0;
  let clock = -1;
  try {
    for await (const frame of framesAt(src, order.map((i) => times[i]), read)) {
      const i = order[seen];

      // The tracker's clock is the source's, held strictly rising: a slowed
      // clip reads the same source frame more than once.
      const ms = Math.max(clock + 1, Math.round(times[i] * 1000));
      clock = ms;
      seen++;
      onFrame?.(seen, times.length);
      if (!frame) continue;
      const w = frame.canvas.width;
      const h = frame.canvas.height;
      const found = detector.detect(frame.canvas as TexImageSource, ms);
      const sample = sampleOf(target, found, w / h, prev);
      out[i] = sample;
      if (sample) prev = sample.center;
    }
  } finally {
    detector.close();
  }
  return out;
}

/** One task per read, so VIDEO-mode state never carries from one clip into
 * another, and its wasm memory goes back when the read ends. */
async function openDetector(target: TrackTarget, confidence: number): Promise<Detector> {
  const tasks = await import("@mediapipe/tasks-vision");
  const fileset = await visionFileset();
  const base = (modelAssetPath: string) => ({ baseOptions: { modelAssetPath }, runningMode: "VIDEO" as const });

  // Hands: both, whatever the target, so a hand's side reads against the other.
  if (target === "hands_gap" || target === "left_hand" || target === "right_hand") {
    const task: HandLandmarker = await withQuietWasmLogs(() =>
      tasks.HandLandmarker.createFromOptions(fileset, {
        ...base(HAND_MODEL),
        numHands: 2,
        minHandDetectionConfidence: confidence,
        minHandPresenceConfidence: confidence,
        minTrackingConfidence: confidence,
      })
    );
    return { detect: (f, ms) => task.detectForVideo(f, ms).landmarks, close: () => task.close() };
  }

  if (target === "head") {
    if (ovalOrder.length === 0) ovalOrder = chainLoop(tasks.FaceLandmarker.FACE_LANDMARKS_FACE_OVAL);
    const task: FaceLandmarker = await withQuietWasmLogs(() =>
      tasks.FaceLandmarker.createFromOptions(fileset, {
        ...base(FACE_MODEL),
        numFaces: MAX_PEOPLE,
        minFaceDetectionConfidence: confidence,
        minFacePresenceConfidence: confidence,
        minTrackingConfidence: confidence,
      })
    );
    return { detect: (f, ms) => task.detectForVideo(f, ms).faceLandmarks, close: () => task.close() };
  }

  const task: PoseLandmarker = await withQuietWasmLogs(() =>
    tasks.PoseLandmarker.createFromOptions(fileset, {
      ...base(POSE_MODEL),
      numPoses: MAX_PEOPLE,
      minPoseDetectionConfidence: confidence,
      minPosePresenceConfidence: confidence,
      minTrackingConfidence: confidence,
    })
  );
  return { detect: (f, ms) => task.detectForVideo(f, ms).landmarks, close: () => task.close() };
}

/** The target's sample in one frame's detections, or null when it is not
 * there. `aspect` is the frame's width over height: hulls, angles and
 * distances are measured in square pixels. `prev` is the target's center a
 * frame earlier, which keeps the track on the same hand, face or body. */
export function sampleOf(target: TrackTarget, found: Landmarks[], aspect: number, prev: MaskPoint | null): TrackSample | null {
  const pad = trackTargetOf(target).pad;
  const sq = (p: MaskPoint): MaskPoint => ({ x: p.x * aspect, y: p.y });
  const unsq = (p: MaskPoint): MaskPoint => ({ x: p.x / aspect, y: p.y });
  const unsqAll = (s: TrackSample): TrackSample => ({
    outline: s.outline.map(unsq),
    center: unsq(s.center),
    axis: [unsq(s.axis[0]), unsq(s.axis[1])],
  });

  // The window between two hands: the thumb and index tips of each, in
  // order around their middle. The hand on the left of the picture is first.
  if (target === "hands_gap") {
    if (found.length < 2) return null;
    const [a, b] = [...found].sort((p, q) => p[HAND.wrist].x - q[HAND.wrist].x).map((l) => l.map(sq));
    const tips = [a[HAND.thumbTip], a[HAND.indexTip], b[HAND.thumbTip], b[HAND.indexTip]];
    const center = mean(tips);

    // Corners keep their identity frame to frame — the left index tip leads —
    // so blending between frames moves each corner along its own path.
    const ring = aroundCenter(tips, center);
    const lead = ring.indexOf(a[HAND.indexTip]);
    return unsqAll({
      outline: [...ring.slice(lead), ...ring.slice(0, lead)],
      center,
      axis: [mean([a[HAND.thumbTip], a[HAND.indexTip]]), mean([b[HAND.thumbTip], b[HAND.indexTip]])],
    });
  }

  if (target === "left_hand" || target === "right_hand") {
    const hand = pickHand(found, target, prev);
    if (!hand) return null;
    const pts = hand.map(sq);
    const center = mean([HAND.wrist, HAND.indexMcp, HAND.middleMcp, HAND.ringMcp, HAND.pinkyMcp].map((j) => pts[j]));
    const outline = hullRing(pts, pad);
    if (!outline) return null;
    return unsqAll({ outline, center, axis: [pts[HAND.wrist], pts[HAND.middleMcp]] });
  }

  if (target === "head") {
    const face = pickNearest(found, prev, (l) => mean(l));
    if (!face) return null;
    const pts = face.map(sq);
    const oval = ovalOrder.map((j) => pts[j]);
    const center = mean(oval);
    return unsqAll({
      outline: grow(oval, center, pad),
      center,
      axis: [pts[FACE.rightEyeOuter], pts[FACE.leftEyeOuter]],
    });
  }

  // A body: the hull of the joints the model can see, around the torso.
  const torsoOf = (l: Landmarks) => {
    const torso = [POSE.leftShoulder, POSE.rightShoulder, POSE.leftHip, POSE.rightHip].map((j) => l[j]).filter((p) => (p.visibility ?? 0) >= POSE_VISIBLE);
    return torso.length > 0 ? mean(torso) : mean(l);
  };
  const body = pickNearest(found, prev, torsoOf);
  if (!body) return null;
  const visible = body.filter((p) => (p.visibility ?? 0) >= POSE_VISIBLE).map(sq);
  const outline = hullRing(visible, pad);
  if (!outline) return null;
  const pts = body.map(sq);
  return unsqAll({
    outline,
    center: sq(torsoOf(body)),
    axis: [pts[POSE.rightShoulder], pts[POSE.leftShoulder]],
  });
}

/** The hand on the asked-for side of the picture. With both in view, side
 * decides; with one, it stays the tracked hand while it is near where that
 * hand was, and otherwise counts when it sits on that half of the picture. */
function pickHand(found: Landmarks[], side: "left_hand" | "right_hand", prev: MaskPoint | null): Landmarks | null {
  if (found.length === 0) return null;
  const left = side === "left_hand";
  if (found.length >= 2) {
    const sorted = [...found].sort((p, q) => p[HAND.wrist].x - q[HAND.wrist].x);
    return left ? sorted[0] : sorted[sorted.length - 1];
  }
  const only = found[0];
  const at = only[HAND.middleMcp];
  if (prev) return dist(at, prev) <= SAME_TARGET ? only : null;
  return (at.x < 0.5) === left ? only : null;
}

/** The detection nearest where the target was; the largest when the track
 * has no history. Null when every detection is too far to be the same one. */
function pickNearest(found: Landmarks[], prev: MaskPoint | null, centerOf: (l: Landmarks) => MaskPoint): Landmarks | null {
  if (found.length === 0) return null;
  if (!prev) {
    const spread = (l: Landmarks) => {
      const xs = l.map((p) => p.x);
      const ys = l.map((p) => p.y);
      return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    };
    return found.reduce((best, l) => (spread(l) > spread(best) ? l : best));
  }
  const best = found.reduce((a, l) => (dist(centerOf(l), prev) < dist(centerOf(a), prev) ? l : a));
  return dist(centerOf(best), prev) <= SAME_TARGET ? best : null;
}

let ovalOrder: number[] = [];

/** The face mesh's oval as one loop of landmark indices, chained from the
 * model's own connection list. */
function chainLoop(edges: { start: number; end: number }[]): number[] {
  const next = new Map(edges.map((e) => [e.start, e.end]));
  const loop = [edges[0].start];
  for (let at = next.get(loop[0]); at !== undefined && at !== loop[0]; at = next.get(at)) loop.push(at);
  return loop;
}

const mean = (pts: MaskPoint[]): MaskPoint => ({
  x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
  y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
});

const dist = (a: MaskPoint, b: MaskPoint) => Math.hypot(a.x - b.x, a.y - b.y);

/** Points in order around `c`, starting from the top. */
function aroundCenter(pts: MaskPoint[], c: MaskPoint): MaskPoint[] {
  const angle = (p: MaskPoint) => (Math.atan2(p.y - c.y, p.x - c.x) + Math.PI * 2.5) % (Math.PI * 2);
  return [...pts].sort((a, b) => angle(a) - angle(b));
}

/** Points pushed out from `c` by `pad` of their distance. */
const grow = (pts: MaskPoint[], c: MaskPoint, pad: number): MaskPoint[] =>
  pts.map((p) => ({ x: c.x + (p.x - c.x) * (1 + pad), y: c.y + (p.y - c.y) * (1 + pad) }));

/** The convex hull of `pts`, grown by `pad` and resampled to RING_POINTS
 * corners at even angles around its middle, so outlines from different
 * frames line up corner for corner. Null for fewer than three points. */
export function hullRing(pts: MaskPoint[], pad: number): MaskPoint[] | null {
  const hull = convexHull(pts);
  if (hull.length < 3) return null;
  const c = mean(hull);
  const ring: MaskPoint[] = [];
  for (let k = 0; k < RING_POINTS; k++) {
    const theta = (k / RING_POINTS) * Math.PI * 2 - Math.PI / 2;
    const d = { x: Math.cos(theta), y: Math.sin(theta) };
    let reach = 0;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i];
      const b = hull[(i + 1) % hull.length];
      const e = { x: b.x - a.x, y: b.y - a.y };
      const w = { x: a.x - c.x, y: a.y - c.y };
      const denom = cross(d, e);
      if (Math.abs(denom) < 1e-12) continue;
      const t = cross(w, e) / denom;
      const s = cross(w, d) / denom;
      if (t >= 0 && s >= -1e-9 && s <= 1 + 1e-9) reach = Math.max(reach, t);
    }
    ring.push({ x: c.x + d.x * reach, y: c.y + d.y * reach });
  }
  return grow(ring, c, pad);
}

const cross = (u: MaskPoint, v: MaskPoint) => u.x * v.y - u.y * v.x;

/** Andrew's monotone chain, counter-clockwise without repeats. */
function convexHull(input: MaskPoint[]): MaskPoint[] {
  const pts = [...input].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const turn = (o: MaskPoint, a: MaskPoint, b: MaskPoint) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: MaskPoint[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: MaskPoint[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
