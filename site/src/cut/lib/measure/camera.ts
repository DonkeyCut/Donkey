/** The camera's move over a stretch of a source: each frame's zoom, shift and
 * turn against the stretch's first frame, found by warping that frame until
 * it lands on this one. A punch-in, a beat zoom, a shake or a slow push in a
 * reference keys as a clip's pose track (set_clip_keyframes) from these
 * numbers, and holdsStill tells a picture that holds under the move — a
 * freeze the template zooms and shakes — from a live one.
 * Pure data in, pure data out; sourceMeasure.ts feeds it decoded frames. */

import type { Pixels } from "./color";

/** A frame as luma, one float a pixel. */
export interface Gray {
  width: number;
  height: number;
  data: Float32Array;
}

/** How a frame sits against the reference frame: `scale` > 1 is zoomed in,
 * `dx`/`dy` move the picture's centre (frame fractions, + is right and
 * down), `rotation` turns it clockwise in degrees, and `residual` is the mean
 * per-pixel difference left after the warp, 0..255. */
export interface CameraPose {
  scale: number;
  dx: number;
  dy: number;
  rotation: number;
  residual: number;
  /** A second layer moving its own way: a cutout held over a background
   * that shakes, or one pulsing over a still. Its pose is read at half size,
   * and `share` is the part of the matched patches it holds. */
  second?: { scale: number; dx: number; dy: number; rotation: number; share: number };
}

/** The long side frames are read at for the camera: a pixel is half a
 * percent of it, and a patch match lands to a tenth of one. */
export const CAMERA_LONG_SIDE = 192;

export function grayOf(px: Pixels): Gray {
  const data = new Float32Array(px.width * px.height);
  for (let i = 0; i < data.length; i++) {
    data[i] = 0.2126 * px.data[i * 4] + 0.7152 * px.data[i * 4 + 1] + 0.0722 * px.data[i * 4 + 2];
  }
  return { width: px.width, height: px.height, data };
}

/** Patches across the frame, cols × rows; the camera is fitted to the ones
 * that agree, so a subject crossing some of them is outvoted. */
const GRID = { cols: 10, rows: 6 };
/** A patch's half side, and how far it is searched each way past where a
 * pose puts it: wide on the half-size pass that catches a shake's jump, close
 * on the full-size one that places it to a tenth of a pixel. */
const PATCH_R = 6;
const COARSE_R = 8;
const FINE_R = 3;
/** A patch flatter than this (high-passed std) has nothing to match: sky,
 * snow, a blown-out flash. */
const MIN_TEXTURE = 3;
/** Frames the fit needs this many agreeing patches to trust. */
const MIN_PATCHES = 6;

/** The frame minus its own blur: edges and texture without the light over
 * them, so a vignette fixed to the screen, a sky's gradient and a beat's
 * exposure pulse do not pull the fit. */
function highPass(g: Gray, r = 4): Gray {
  const { width: w, height: h } = g;
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += g.data[y * w + x];
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
    }
  }
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const sum = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
      data[y * w + x] = g.data[y * w + x] - sum / ((x1 - x0) * (y1 - y0));
    }
  }
  return { width: w, height: h, data };
}

/** Half the size, each pixel the mean of four. */
function halve(g: Gray): Gray {
  const w = Math.max(1, Math.floor(g.width / 2));
  const h = Math.max(1, Math.floor(g.height / 2));
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = 2 * y * g.width + 2 * x;
      data[y * w + x] = (g.data[i] + g.data[i + 1] + g.data[i + g.width] + g.data[i + g.width + 1]) / 4;
    }
  }
  return { width: w, height: h, data };
}

function sample(g: Gray, x: number, y: number): number {
  if (x < 0 || y < 0 || x > g.width - 1.001 || y > g.height - 1.001) return NaN;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * g.width + x0;
  return (
    (g.data[i] * (1 - fx) + g.data[i + 1] * fx) * (1 - fy) + (g.data[i + g.width] * (1 - fx) + g.data[i + g.width + 1] * fx) * fy
  );
}

/** Mean absolute difference between `cur` and `ref` warped by the pose (shift
 * in pixels of these frames), over the pixels whose source lies inside `ref`.
 * Infinity when too little overlaps. */
function cost(ref: Gray, cur: Gray, s: number, dxPx: number, dyPx: number, rotDeg: number, step: number): number {
  const { width: w, height: h } = cur;
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const th = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(th) / s;
  const sin = Math.sin(th) / s;
  let sum = 0;
  let n = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      // The reference point that lands on (x, y): undo the shift, the turn
      // and the zoom about the centre.
      const px = x - cx - dxPx;
      const py = y - cy - dyPx;
      const v = sample(ref, cx + cos * px + sin * py, cy - sin * px + cos * py);
      if (Number.isNaN(v)) continue;
      sum += Math.abs(v - cur.data[y * w + x]);
      n++;
    }
  }
  // A warp that leaves less than a third of the frame overlapping proves nothing.
  return n * step * step < (w * h) / 3 ? Infinity : sum / n;
}

interface Pose {
  s: number;
  rot: number;
  tx: number;
  ty: number;
}

/** Where a point of the reference (from the centre) lands under a pose. */
function place(p: Pose, x: number, y: number): [number, number] {
  const th = (p.rot * Math.PI) / 180;
  const a = p.s * Math.cos(th);
  const b = p.s * Math.sin(th);
  return [a * x - b * y + p.tx, b * x + a * y + p.ty];
}

/** A match within this many pixels of where a pose puts it agrees with it. */
const AGREE_PX = 1;

/** The least-squares zoom, turn and shift over the pairs `idx`:
 * q = [a -b; b a] p + t, solved with the means taken out. */
function solvePose(from: [number, number][], to: [number, number][], idx: number[]): Pose | null {
  let mpx = 0, mpy = 0, mqx = 0, mqy = 0;
  for (const i of idx) {
    mpx += from[i][0]; mpy += from[i][1]; mqx += to[i][0]; mqy += to[i][1];
  }
  mpx /= idx.length; mpy /= idx.length; mqx /= idx.length; mqy /= idx.length;
  let saa = 0, sab = 0, spp = 0;
  for (const i of idx) {
    const px = from[i][0] - mpx, py = from[i][1] - mpy;
    const qx = to[i][0] - mqx, qy = to[i][1] - mqy;
    saa += px * qx + py * qy;
    sab += px * qy - py * qx;
    spp += px * px + py * py;
  }
  if (spp <= 0) return null;
  const a = saa / spp;
  const b = sab / spp;
  return { s: Math.hypot(a, b), rot: (Math.atan2(b, a) * 180) / Math.PI, tx: mqx - (a * mpx - b * mpy), ty: mqy - (b * mpx + a * mpy) };
}

/** The pairs a pose agrees with. */
function agreeing(pose: Pose, from: [number, number][], to: [number, number][], px: number): number[] {
  return from.flatMap((p, i) => {
    const [x, y] = place(pose, p[0], p[1]);
    return Math.hypot(x - to[i][0], y - to[i][1]) <= px ? [i] : [];
  });
}

/** The zoom, turn and shift that carry `from` onto `to` (points from the
 * centre) by consensus: every two pairs propose a pose, the one most pairs
 * agree with wins, and it is refitted over them. Snow, sky and a subject
 * moving through mismatch at random and agree with nothing. Null with fewer
 * than MIN_PATCHES agreeing. */
function fitPose(from: [number, number][], to: [number, number][], px = AGREE_PX): { pose: Pose; kept: number; agree: number[] } | null {
  if (from.length < MIN_PATCHES) return null;
  let best: number[] = [];
  for (let i = 0; i < from.length; i++) {
    for (let j = i + 1; j < from.length; j++) {
      // Two points too close together cannot tell a zoom or a turn.
      if (Math.hypot(from[i][0] - from[j][0], from[i][1] - from[j][1]) < 8 * px) continue;
      const pose = solvePose(from, to, [i, j]);
      if (!pose || pose.s < 0.5 || pose.s > 2) continue;
      const agree = agreeing(pose, from, to, px);
      if (agree.length > best.length) best = agree;
    }
  }
  if (best.length < MIN_PATCHES) return null;
  let pose = solvePose(from, to, best)!;
  let agree = agreeing(pose, from, to, px);
  if (agree.length >= MIN_PATCHES) pose = solvePose(from, to, agree)!;
  else agree = best;
  return { pose, kept: agree.length, agree };
}

interface Patch {
  /** Its centre from the frame's centre. */
  x: number;
  y: number;
  pixels: Float32Array;
}

/** The textured patches of the reference frame, on the grid. */
function patchesOf(g: Gray): Patch[] {
  const margin = PATCH_R + 2;
  const cx = (g.width - 1) / 2;
  const cy = (g.height - 1) / 2;
  const out: Patch[] = [];
  for (let r = 0; r < GRID.rows; r++) {
    for (let c = 0; c < GRID.cols; c++) {
      const x = Math.round(margin + ((g.width - 2 * margin) * (c + 0.5)) / GRID.cols);
      const y = Math.round(margin + ((g.height - 2 * margin) * (r + 0.5)) / GRID.rows);
      const pixels = new Float32Array((2 * PATCH_R + 1) ** 2);
      let k = 0, sum = 0, sq = 0;
      for (let v = -PATCH_R; v <= PATCH_R; v++) {
        for (let u = -PATCH_R; u <= PATCH_R; u++) {
          const p = g.data[(y + v) * g.width + x + u];
          pixels[k++] = p;
          sum += p;
          sq += p * p;
        }
      }
      const std = Math.sqrt(Math.max(0, sq / k - (sum / k) ** 2));
      if (std >= MIN_TEXTURE) out.push({ x: x - cx, y: y - cy, pixels });
    }
  }
  return out;
}

/** Where a reference patch sits in `cur`, searched around where `pose` puts
 * it, with the patch zoomed and turned as the pose has it; null when it runs
 * off the frame or its best match is no better than its neighbours'. */
function matchPatch(cur: Gray, patch: Patch, pose: Pose, SEARCH_R: number): [number, number] | null {
  const cx = (cur.width - 1) / 2;
  const cy = (cur.height - 1) / 2;
  const [px, py] = place(pose, patch.x, patch.y);
  const th = (pose.rot * Math.PI) / 180;
  const a = pose.s * Math.cos(th);
  const b = pose.s * Math.sin(th);
  const n = 2 * SEARCH_R + 1;
  const costs = new Float32Array(n * n).fill(Infinity);
  let best = Infinity;
  let bi = -1;
  for (let oy = -SEARCH_R; oy <= SEARCH_R; oy++) {
    for (let ox = -SEARCH_R; ox <= SEARCH_R; ox++) {
      let sum = 0;
      let k = 0;
      let off = false;
      for (let v = -PATCH_R; v <= PATCH_R && !off; v++) {
        for (let u = -PATCH_R; u <= PATCH_R; u++) {
          const val = sample(cur, cx + px + ox + a * u - b * v, cy + py + oy + b * u + a * v);
          if (Number.isNaN(val)) {
            off = true;
            break;
          }
          sum += Math.abs(val - patch.pixels[k++]);
        }
      }
      if (off) continue;
      const i = (oy + SEARCH_R) * n + ox + SEARCH_R;
      costs[i] = sum;
      if (sum < best) {
        best = sum;
        bi = i;
      }
    }
  }
  if (bi < 0) return null;
  const bx = (bi % n) - SEARCH_R;
  const by = Math.floor(bi / n) - SEARCH_R;
  // A best on the search's edge may lie past it.
  if (Math.abs(bx) === SEARCH_R || Math.abs(by) === SEARCH_R) return null;
  // The parabola through the best and its neighbours puts it between pixels.
  const sub = (l: number, c: number, r: number) => {
    const d = l - 2 * c + r;
    return d > 0 && Number.isFinite(d) ? Math.max(-0.5, Math.min(0.5, (l - r) / (2 * d))) : 0;
  };
  const at = (x: number, y: number) => costs[(y + SEARCH_R) * n + x + SEARCH_R];
  return [
    px + bx + sub(at(bx - 1, by), best, at(bx + 1, by)),
    py + by + sub(at(bx, by - 1), best, at(bx, by + 1)),
  ];
}

/** The pose that carries `patches` of the reference onto `cur`, searched
 * `reach` pixels around where `start` puts each one. */
function matchAll(cur: Gray, patches: Patch[], start: Pose, reach: number) {
  const from: [number, number][] = [];
  const to: [number, number][] = [];
  for (const p of patches) {
    const hit = matchPatch(cur, p, start, reach);
    if (hit) {
      from.push([p.x, p.y]);
      to.push(hit);
    }
  }
  return { from, to };
}

function fitFrom(cur: Gray, patches: Patch[], start: Pose, reach: number, px = AGREE_PX) {
  const { from, to } = matchAll(cur, patches, start, reach);
  return fitPose(from, to, px);
}

/** The layers the matches split into: the pose most of them agree with, and
 * the pose most of the rest agree with, when enough do. */
function layersOf(cur: Gray, patches: Patch[], start: Pose, reach: number, px: number) {
  const { from, to } = matchAll(cur, patches, start, reach);
  const first = fitPose(from, to, px);
  if (!first) return [];
  const taken = new Set(first.agree);
  const rest = from.flatMap((_, i) => (taken.has(i) ? [] : [i]));
  const second = fitPose(rest.map((i) => from[i]), rest.map((i) => to[i]), px);
  const share = (n: number) => n / from.length;
  return second && apart(first.pose, second.pose, cur, 2 * px)
    ? [{ pose: first.pose, share: share(first.kept) }, { pose: second.pose, share: share(second.kept) }]
    : [{ pose: first.pose, share: share(first.kept) }];
}

/** Whether two poses put some corner of the frame more than `px` apart. */
function apart(a: Pose, b: Pose, g: Gray, px: number): boolean {
  const hw = g.width / 2;
  const hh = g.height / 2;
  return [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh], [0, 0]].some(([x, y]) => {
    const [ax, ay] = place(a, x, y);
    const [bx, by] = place(b, x, y);
    return Math.hypot(ax - bx, ay - by) > px;
  });
}

/** How far apart two poses put the frame's corners, at most. */
function gap(a: Pose, b: Pose, g: Gray): number {
  const hw = g.width / 2;
  const hh = g.height / 2;
  return Math.max(
    ...[[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]].map(([x, y]) => {
      const [ax, ay] = place(a, x, y);
      const [bx, by] = place(b, x, y);
      return Math.hypot(ax - bx, ay - by);
    })
  );
}

/** Layers holding shares this close are near even. */
const EVEN_SHARE = 0.1;
/** A second layer holds at least this share of the matched patches in a
 * frame, and shows in at least SECOND_FRAMES of the stretch's frames: less
 * is a few patches mismatching together, not a layer. */
const SECOND_SHARE = 0.25;
const SECOND_FRAMES = 0.25;

const half = (p: Pose): Pose => ({ ...p, tx: p.tx / 2, ty: p.ty / 2 });
const REST: Pose = { s: 1, rot: 0, tx: 0, ty: 0 };

/** Each frame's pose against `frames[0]`, read at CAMERA_LONG_SIDE: the
 * reference frame's textured patches are found again in each frame and one
 * zoom, turn and shift is fitted to the patches that agree. A half-size pass
 * from the frame before's pose, and from rest, catches a jump; the better
 * fit is placed at full size. A frame too blurred or too changed to fit
 * keeps the pose before it, with residual Infinity. */
export function cameraPath(frames: Gray[]): CameraPose[] {
  if (frames.length === 0) return [];
  const ref = highPass(frames[0]);
  const refHalf = highPass(halve(frames[0]), 2);
  const patches = patchesOf(ref);
  const patchesHalf = patchesOf(refHalf);
  const out: CameraPose[] = [{ scale: 1, dx: 0, dy: 0, rotation: 0, residual: 0 }];
  let prev: Pose = REST;
  for (let i = 1; i < frames.length; i++) {
    const cur = highPass(frames[i]);
    const curHalf = highPass(halve(frames[i]), 2);
    // The layers seen from the frame before and from rest. The camera is the
    // one holding most of the picture — of two near even, the one carrying
    // on from the frame before — and another holding a fair share of its
    // own is the second layer.
    const layers = [...layersOf(curHalf, patchesHalf, half(prev), COARSE_R, AGREE_PX * 0.75), ...layersOf(curHalf, patchesHalf, REST, COARSE_R, AGREE_PX * 0.75)]
      .sort((a, b) => b.share - a.share);
    const main = layers
      .filter((l) => l.share >= layers[0].share - EVEN_SHARE)
      .sort((a, b) => gap(a.pose, half(prev), curHalf) - gap(b.pose, half(prev), curHalf))[0];
    const other = main && layers.find((l) => l.share >= SECOND_SHARE && apart(l.pose, main.pose, curHalf, 1.5));
    const start = main ? { ...main.pose, tx: main.pose.tx * 2, ty: main.pose.ty * 2 } : prev;
    const fit = fitFrom(cur, patches, start, FINE_R);
    if (!fit) {
      out.push({ ...out[out.length - 1], residual: Infinity });
      continue;
    }
    prev = fit.pose;
    out.push({
      scale: fit.pose.s,
      dx: fit.pose.tx / cur.width,
      dy: fit.pose.ty / cur.height,
      rotation: fit.pose.rot,
      residual: cost(ref, cur, fit.pose.s, fit.pose.tx, fit.pose.ty, fit.pose.rot, 2),
      ...(other
        ? {
            second: {
              scale: other.pose.s,
              dx: other.pose.tx / curHalf.width,
              dy: other.pose.ty / curHalf.height,
              rotation: other.pose.rot,
              share: other.share,
            },
          }
        : {}),
    });
  }
  const layered = out.filter((p) => p.second).length;
  if (layered < SECOND_FRAMES * (out.length - 1)) for (const p of out) delete p.second;
  return out;
}

/** Two frames the camera holds the same way differ by less than this a pixel
 * when the picture under it is one frame: a returning live shot has moved on. */
export const STILL_RESIDUAL = 2;

/** Poses this close show the same part of the picture the same way. */
const SAME_POSE = { scale: 0.004, d: 0.003, rotation: 0.2 };

/** Whether one picture holds under the whole move — a freeze the template
 * zooms or shakes — by the frames where the camera comes back to a pose it
 * held at least two frames before: a frozen picture is the same frame again,
 * a live one has moved on. The warp's own residual cannot tell, since a
 * screen-fixed vignette or grain over a zoomed freeze leaves one too. Null
 * when the camera never returns, as in a steady push. */
export function holdsStill(frames: Gray[], path: CameraPose[]): boolean | null {
  const diffs: number[] = [];
  for (let i = 2; i < frames.length; i++) {
    for (let j = 0; j <= i - 2; j++) {
      const a = path[i];
      const b = path[j];
      if (
        Math.abs(a.scale - b.scale) < SAME_POSE.scale &&
        Math.abs(a.dx - b.dx) < SAME_POSE.d &&
        Math.abs(a.dy - b.dy) < SAME_POSE.d &&
        Math.abs(a.rotation - b.rotation) < SAME_POSE.rotation
      ) {
        diffs.push(cost(frames[j], frames[i], 1, 0, 0, 0, 1));
        break;
      }
    }
  }
  if (diffs.length < 2) return null;
  diffs.sort((x, y) => x - y);
  return diffs[Math.floor(diffs.length / 2)] < STILL_RESIDUAL;
}
