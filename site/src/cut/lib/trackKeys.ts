/**
 * From a raw track to keys an item plays.
 *
 * tracking.ts reports where a target sits in the source picture, frame by
 * frame. This module settles that path — short dropouts bridged, jitter taken
 * out with a one-euro filter that stays tight on fast moves — then places it
 * in the project frame through the clip's own framing (region, fit, zoom,
 * pan, mirror), and writes it as keys: a pen mask whose outline is keyed per
 * frame, or a pose track that carries an item along with the target. Keys a
 * straight line between their neighbors already draws are dropped, so the
 * doc holds the path's turns and nothing more.
 *
 * Everything here is pure geometry, so the page, a test, and any later
 * surface agree on what a track means.
 */

import { evalOverlayFrame, type Mask, type MaskKey, type OverlayKey } from "@donkeycut/effects-kit";
import { clipCovers, clipZoom, contentRect, frameOf, rectOf, type Aspect, type Overlay, type VideoClip } from "./types";

export interface Pt {
  x: number;
  y: number;
}

/** One moment of a target: its outline, its center, and two points along
 * its own axis, whose angle is the target's turn and whose length its size. */
export interface TrackSample {
  outline: Pt[];
  center: Pt;
  axis: [Pt, Pt];
}

export interface TrackTuning {
  smoothCutoff: number;
  smoothBeta: number;
  bridgeSeconds: number;
  keyTolerance: number;
}

/** The derivative's own smoothing cutoff, Hz — the one-euro default. */
const DERIVATIVE_CUTOFF = 1;

/** How much of the target's motion a follow carries. */
export type FollowMode = "move" | "move_scale" | "move_scale_turn";
export const FOLLOW_MODES: FollowMode[] = ["move", "move_scale", "move_scale_turn"];

const flatten = (s: TrackSample): number[] => [
  ...s.outline.flatMap((p) => [p.x, p.y]),
  s.center.x,
  s.center.y,
  s.axis[0].x,
  s.axis[0].y,
  s.axis[1].x,
  s.axis[1].y,
];

function unflatten(v: number[]): TrackSample {
  const n = (v.length - 6) / 2;
  const at = (i: number): Pt => ({ x: v[i * 2], y: v[i * 2 + 1] });
  return {
    outline: Array.from({ length: n }, (_, i) => at(i)),
    center: at(n),
    axis: [at(n + 1), at(n + 2)],
  };
}

/**
 * Bridge dropouts no longer than `bridgeSeconds` by blending the samples on
 * either side, then smooth every coordinate along each unbroken run. `times`
 * are timeline seconds, rising.
 */
export function settleTrack(times: number[], samples: (TrackSample | null)[], tune: TrackTuning): (TrackSample | null)[] {
  const vecs = samples.map((s) => (s ? flatten(s) : null));

  // A short dropout — a blur, a hand turning edge-on — is the target still
  // there; a longer one is the target gone.
  for (let i = 0; i < vecs.length; i++) {
    if (vecs[i]) continue;
    const before = i - 1;
    let after = i;
    while (after < vecs.length && !vecs[after]) after++;
    const a = vecs[before];
    const b = vecs[after];
    if (a && b && a.length === b.length && times[after] - times[before] <= tune.bridgeSeconds + 1e-6) {
      for (let k = i; k < after; k++) {
        const p = (times[k] - times[before]) / (times[after] - times[before]);
        vecs[k] = a.map((u, d) => u + (b[d] - u) * p);
      }
    }
    i = after;
  }

  // One-euro per coordinate, restarting after every gap: a still target
  // settles at the low cutoff, a moving one lifts it and keeps up.
  let filters: OneEuro[] | null = null;
  return vecs.map((v, i) => {
    if (!v) {
      filters = null;
      return null;
    }
    filters ??= v.map(() => new OneEuro(tune.smoothCutoff, tune.smoothBeta));
    return unflatten(v.map((u, d) => filters![d].next(u, times[i])));
  });
}

/** The one-euro filter: an exponential smoother whose cutoff rises with the
 * signal's speed, so jitter goes and fast moves keep their timing. */
class OneEuro {
  private value: number | null = null;
  private slope = 0;
  private at = 0;

  constructor(
    private readonly cutoff: number,
    private readonly beta: number
  ) {}

  next(x: number, t: number): number {
    if (this.value === null) {
      this.value = x;
      this.at = t;
      return x;
    }
    const dt = t - this.at;
    if (dt <= 0) return this.value;
    const alpha = (hz: number) => 1 / (1 + 1 / (2 * Math.PI * hz * dt));
    this.slope += alpha(DERIVATIVE_CUTOFF) * ((x - this.value) / dt - this.slope);
    this.value += alpha(this.cutoff + this.beta * Math.abs(this.slope)) * (x - this.value);
    this.at = t;
    return this.value;
  }
}

/**
 * Where a point of a clip's source picture (0..1 across it) lands in the
 * project frame (fractions of it), the way the compositor draws the clip:
 * into its region, fitted or covering, zoomed, panned, and mirrored about the
 * region's center. Pose keys and turns apply after masks, so they stay out.
 */
export function pictureToFrame(
  clip: VideoClip,
  picture: { width: number; height: number },
  aspect: Aspect
): (p: Pt) => Pt {
  const fr = frameOf(aspect);
  const r = rectOf(clip);
  const box = { x: r.x * fr.w, y: r.y * fr.h, w: r.w * fr.w, h: r.h * fr.h };
  const c = contentRect(box, picture.width, picture.height, clipCovers(clip), clipZoom(clip), clip.panX ?? 0, clip.panY ?? 0);
  const midX = box.x + box.w / 2;
  const midY = box.y + box.h / 2;
  return (p) => {
    let x = c.x + p.x * c.w;
    let y = c.y + p.y * c.h;
    if (clip.flipH) x = 2 * midX - x;
    if (clip.flipV) y = 2 * midY - y;
    return { x: x / fr.w, y: y / fr.h };
  };
}

/** An item a track writes onto: a video clip or an overlay element. */
export type TrackItem = { kind: "clip"; clip: VideoClip } | { kind: "overlay"; overlay: Overlay };

const itemStart = (item: TrackItem) => (item.kind === "clip" ? item.clip.start : item.overlay.start);

/**
 * A frame point as an offset from the item's mask anchor, in the item's own
 * unposed space at `tLocal`: a clip's masks sit before its pose, so its
 * region center is the anchor; an element's mask paints under the element's
 * transform, so the point is carried back through it.
 */
function toMaskSpace(item: TrackItem, aspect: Aspect, tLocal: number): (p: Pt) => Pt {
  if (item.kind === "clip") {
    const r = rectOf(item.clip);
    const ax = r.x + r.w / 2;
    const ay = r.y + r.h / 2;
    return (p) => ({ x: p.x - ax, y: p.y - ay });
  }
  const o = item.overlay;
  const fr = frameOf(aspect);
  const ds = Math.min(fr.w, fr.h) / 1080;
  const ev = evalOverlayFrame(o, tLocal, fr.w / fr.h);
  const turn = (-ev.rotation * Math.PI) / 180;
  const scale = Math.max(1e-6, ev.scale);
  return (p) => {
    const vx = p.x * fr.w - (ev.x * fr.w + ev.dx * ds);
    const vy = p.y * fr.h - (ev.y * fr.h + ev.dy * ds);
    const qx = (vx * Math.cos(turn) - vy * Math.sin(turn)) / scale;
    const qy = (vx * Math.sin(turn) + vy * Math.cos(turn)) / scale;
    return { x: qx / fr.w, y: qy / fr.h };
  };
}

/**
 * A pen mask that traces the target: one key per kept moment, each carrying
 * the outline there. Where the target is gone the outline folds to a point at
 * its last place, so the masked picture shows nothing until it returns.
 * `times` are timeline seconds; `frame` holds the settled samples already
 * placed in the project frame.
 */
export function trackedMask(
  item: TrackItem,
  aspect: Aspect,
  times: number[],
  frame: (TrackSample | null)[],
  base: Pick<Mask, "feather" | "invert">,
  tolerance: number
): Mask | null {
  const first = frame.find((s) => s !== null);
  if (!first) return null;
  const corners = first.outline.length;
  let last = first.center;

  // Each moment's outline in the item's mask space.
  const outlines = frame.map((s, i) => {
    const local = toMaskSpace(item, aspect, times[i] - itemStart(item));
    if (s) last = s.center;
    const pts = s ? s.outline : Array.from({ length: corners }, () => last);
    return pts.map(local);
  });
  const kept = keepTurns(times, outlines.map((o) => o.flatMap((p) => [p.x, p.y])), tolerance);
  const feather = base.feather ?? 0;
  const kf: MaskKey[] = kept.map((i) => ({
    t: round4(times[i] - itemStart(item)),
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    rotation: 0,
    feather,
    points: outlines[i].map((p) => ({ x: round4(p.x), y: round4(p.y) })),
  }));
  return {
    kind: "pen",
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    rotation: 0,
    ...(feather > 0 ? { feather } : {}),
    ...(base.invert ? { invert: true } : {}),
    points: kf[0].points,
    kf,
  };
}

/** Where an item rests before a follow moves it: its center in frame
 * fractions, its scale, turn and opacity. */
export interface RestPose {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
}

/**
 * Pose keys that carry an item with the target. The item keeps where it sits
 * relative to the target at the first tracked moment — beside a head, over a
 * hand — and from there moves with it; `move_scale` also grows and shrinks
 * with the target's size, `move_scale_turn` also turns with it. Moments where
 * the target is gone write no key, so the item holds.
 */
export function followKeys(
  item: TrackItem,
  aspect: Aspect,
  times: number[],
  frame: (TrackSample | null)[],
  rest: RestPose,
  mode: FollowMode,
  tolerance: number
): OverlayKey[] {
  const fr = frameOf(aspect);
  const px = (p: Pt) => ({ x: p.x * fr.w, y: p.y * fr.h });
  const measure = (s: TrackSample) => {
    const a = px(s.axis[0]);
    const b = px(s.axis[1]);
    return { c: px(s.center), size: Math.max(1e-6, Math.hypot(b.x - a.x, b.y - a.y)), angle: Math.atan2(b.y - a.y, b.x - a.x) };
  };
  const firstAt = frame.findIndex((s) => s !== null);
  if (firstAt < 0) return [];
  const ref = measure(frame[firstAt]!);
  const offset = { x: rest.x * fr.w - ref.c.x, y: rest.y * fr.h - ref.c.y };

  // The turn unwraps as it goes, so a key never spins the long way round.
  let turn = 0;
  let lastAngle = ref.angle;
  const poses: { i: number; key: OverlayKey }[] = [];
  frame.forEach((s, i) => {
    if (!s) return;
    const m = measure(s);
    let step = m.angle - lastAngle;
    step -= Math.round(step / (Math.PI * 2)) * Math.PI * 2;
    turn += step;
    lastAngle = m.angle;
    const grow = mode === "move" ? 1 : m.size / ref.size;
    const spin = mode === "move_scale_turn" ? turn : 0;
    const ox = (offset.x * Math.cos(spin) - offset.y * Math.sin(spin)) * grow;
    const oy = (offset.x * Math.sin(spin) + offset.y * Math.cos(spin)) * grow;
    poses.push({
      i,
      key: {
        t: round4(times[i] - itemStart(item)),
        x: round4((m.c.x + ox) / fr.w),
        y: round4((m.c.y + oy) / fr.h),
        scale: round4(rest.scale * grow),
        rotation: round2(wrapDegrees(rest.rotation + (spin * 180) / Math.PI)),
        opacity: rest.opacity,
      },
    });
  });

  // Scale and turn weigh in at the tolerance's scale: a 0.3° turn or a 0.3%
  // size change counts like a position move of the tolerance.
  const kept = keepTurns(
    poses.map((p) => times[p.i]),
    poses.map((p) => [p.key.x, p.key.y, p.key.scale * 0.5, p.key.rotation / 200]),
    tolerance
  );
  return kept.map((k) => poses[k].key);
}

/**
 * The indices worth a key: a moment is dropped when the straight line
 * between the kept moments around it passes within `tolerance` of every
 * coordinate it had. The first and last always stay.
 */
export function keepTurns(times: number[], vecs: number[][], tolerance: number): number[] {
  const n = vecs.length;
  if (n <= 2) return vecs.map((_, i) => i);
  const kept = [0];
  let anchor = 0;
  for (let j = 2; j < n; j++) {
    if (!spans(times, vecs, anchor, j, tolerance)) {
      kept.push(j - 1);
      anchor = j - 1;
    }
  }
  kept.push(n - 1);
  return kept;
}

/** Whether the line from `a` to `b` stays within `tolerance` of every moment
 * between them. */
function spans(times: number[], vecs: number[][], a: number, b: number, tolerance: number): boolean {
  const span = times[b] - times[a];
  if (vecs[a].length !== vecs[b].length) return false;
  for (let k = a + 1; k < b; k++) {
    const p = span > 0 ? (times[k] - times[a]) / span : 0;
    const v = vecs[k];
    for (let d = 0; d < v.length; d++) {
      if (Math.abs(vecs[a][d] + (vecs[b][d] - vecs[a][d]) * p - v[d]) > tolerance) return false;
    }
  }
  return true;
}

const wrapDegrees = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
const round2 = (v: number) => Math.round(v * 100) / 100;
