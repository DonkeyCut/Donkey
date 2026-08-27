/**
 * Stroke ink: the outline a removal draws around its subject.
 *
 * One painter turns a silhouette (any image whose alpha marks the subject)
 * into white ink on a transparent canvas; the host colors the ink and lays it
 * behind the keyed layer. Styles come in two families: the dilate styles
 * (glow, solid, offset) stamp or blur the silhouette itself, and the contour
 * styles (dotted, straight cut, hand drawn) walk the silhouette's traced
 * boundary. All of it is plain 2D canvas, so the preview, the in-tab export,
 * and the headless renderers draw the same ink.
 */

import { kitCanvas } from "./surface";
import type { RemovalStroke } from "./removal";
import { STROKE_DEFAULT_WIDTH } from "./removal";

type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Contours trace on a copy about this tall — boundary shape at outline
 * widths survives the downscale, and the per-frame scan stays cheap. */
const TRACE_SHORT = 288;

/** Round stamps that make a dilated edge read as smooth. */
const DILATE_STAMPS = 24;

export interface ContourPoint {
  x: number;
  y: number;
}

/**
 * Boundary loops of the mask's solid pixels (alpha > 127), each an ordered
 * ring of pixel coordinates, outermost first. Moore-neighbor tracing; specks
 * under a few pixels are dropped.
 */
let planeSize = -1;
let solidPlane = new Uint8Array(0);
let tracedPlane = new Uint8Array(0);

export function traceMatteContours(mask: ImageData): ContourPoint[][] {
  const w = mask.width;
  const h = mask.height;
  // Reused across frames: `solid` is fully rewritten, `traced` cleared below.
  if (planeSize !== w * h) {
    planeSize = w * h;
    solidPlane = new Uint8Array(planeSize);
    tracedPlane = new Uint8Array(planeSize);
  }
  const solid = solidPlane;
  for (let i = 0; i < w * h; i++) solid[i] = mask.data[i * 4 + 3] > 127 ? 1 : 0;
  const at = (x: number, y: number) => (x >= 0 && x < w && y >= 0 && y < h ? solid[y * w + x] : 0);
  // Clockwise Moore neighborhood, starting west.
  const NB = [
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
  ];
  const traced = tracedPlane;
  traced.fill(0);
  const loops: ContourPoint[][] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // A boundary start: solid, unvisited, with background to its west (the
      // scan reaches it from the west, which anchors the tracing direction).
      if (!solid[i] || traced[i] || at(x - 1, y)) continue;
      const loop: ContourPoint[] = [];
      const sx = x;
      const sy = y;
      let cx = x;
      let cy = y;
      // Entered from the west.
      let from = 0;
      const cap = w * h * 4;
      for (let step = 0; step < cap; step++) {
        traced[cy * w + cx] = 1;
        loop.push({ x: cx, y: cy });
        // Search the neighborhood clockwise from just past where we came in.
        let found = -1;
        for (let k = 1; k <= 8; k++) {
          const dir = (from + k) % 8;
          if (at(cx + NB[dir][0], cy + NB[dir][1])) {
            found = dir;
            break;
          }
        }
        if (found < 0) break; // an isolated pixel
        cx += NB[found][0];
        cy += NB[found][1];
        // Next search starts from the direction pointing back at the pixel we
        // just left, so the trace hugs the boundary.
        from = (found + 5) % 8;
        if (cx === sx && cy === sy) break;
      }
      if (loop.length >= 8) loops.push(loop);
    }
  }
  loops.sort((a, b) => b.length - a.length);
  return loops;
}

/** Ramer–Douglas–Peucker simplification of a closed ring. */
function simplifyRing(points: ContourPoint[], epsilon: number): ContourPoint[] {
  if (points.length <= 4) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const pa = points[a];
    const pb = points[b];
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy) || 1;
    let worst = 0;
    let worstI = -1;
    for (let i = a + 1; i < b; i++) {
      const p = points[i];
      const d = Math.abs((p.x - pa.x) * dy - (p.y - pa.y) * dx) / len;
      if (d > worst) {
        worst = d;
        worstI = i;
      }
    }
    if (worstI > 0 && worst > epsilon) {
      keep[worstI] = 1;
      stack.push([a, worstI], [worstI, b]);
    }
  }
  const out: ContourPoint[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/** Resample a ring to points evenly spaced `gap` apart along its length. */
function resampleRing(points: ContourPoint[], gap: number): ContourPoint[] {
  const out: ContourPoint[] = [];
  let carry = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (seg <= 0) continue;
    let d = carry;
    while (d < seg) {
      const p = d / seg;
      out.push({ x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p });
      d += gap;
    }
    carry = d - seg;
  }
  return out;
}

/** Scratch canvases reused across frames — the ink paints every preview
 * frame, and each scratch is cleared and fully redrawn before use. One of
 * each is enough: a paint call stages one silhouette (or one contour read)
 * at a time. */
let silCanvas: HTMLCanvasElement | null = null;
let contourCanvas: HTMLCanvasElement | null = null;

function sizedScratch(held: HTMLCanvasElement | null, w: number, h: number): HTMLCanvasElement {
  if (held && held.width === w && held.height === h) return held;
  return kitCanvas(w, h);
}

/** The silhouette as white fill, for stamping. */
function whiteSilhouette(silhouette: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
  const sil = (silCanvas = sizedScratch(silCanvas, w, h));
  const ctx = sil.getContext("2d")!;
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(silhouette, 0, 0, w, h);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "source-over";
  return sil;
}

/** Stamp `sil` at `count` points around a circle of radius `r`. */
function stampAround(ctx: Canvas2D, sil: CanvasImageSource, r: number, count = DILATE_STAMPS) {
  for (let k = 0; k < count; k++) {
    const a = (k / count) * Math.PI * 2;
    ctx.drawImage(sil, Math.cos(a) * r, Math.sin(a) * r);
  }
}

/** The traced rings of a silhouette, downscaled for the scan and mapped back
 * to canvas coordinates, largest first. */
function contoursOf(silhouette: CanvasImageSource, w: number, h: number): ContourPoint[][] {
  const scale = Math.min(1, TRACE_SHORT / Math.max(1, Math.min(w, h)));
  const tw = Math.max(2, Math.round(w * scale));
  const th = Math.max(2, Math.round(h * scale));
  const small = (contourCanvas = sizedScratch(contourCanvas, tw, th));
  const sctx = small.getContext("2d", { willReadFrequently: true })!;
  sctx.clearRect(0, 0, tw, th);
  sctx.drawImage(silhouette, 0, 0, tw, th);
  const rings = traceMatteContours(sctx.getImageData(0, 0, tw, th));
  const up = 1 / scale;
  return rings.map((ring) => ring.map((p) => ({ x: p.x * up, y: p.y * up })));
}

/**
 * Paint the stroke's ink — white on transparent — into `ctx`, sized to the
 * `w`×`h` frame the silhouette was drawn at. `scale` converts the stroke's
 * design px (1080 short side); `t` is the layer's local seconds, driving the
 * hand style's boil.
 */
export function paintStrokeInk(
  ctx: Canvas2D,
  silhouette: CanvasImageSource,
  w: number,
  h: number,
  stroke: RemovalStroke,
  t: number,
  scale: number
): void {
  const width = Math.max(1, (stroke.width ?? STROKE_DEFAULT_WIDTH) * scale);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#ffffff";
  if (stroke.style === "solid") {
    stampAround(ctx, whiteSilhouette(silhouette, w, h), width);
  } else if (stroke.style === "offset") {
    const sil = whiteSilhouette(silhouette, w, h);
    ctx.drawImage(sil, (stroke.offsetX ?? 0) * scale, (stroke.offsetY ?? 0) * scale);
  } else if (stroke.style === "glow") {
    const sil = whiteSilhouette(silhouette, w, h);
    if ("filter" in ctx) {
      ctx.filter = `blur(${Math.max(1, width).toFixed(1)}px)`;
      // Twice, so the halo reads against bright footage too.
      ctx.drawImage(sil, 0, 0);
      ctx.drawImage(sil, 0, 0);
      ctx.filter = "none";
    } else {
      // No blur available (a bare context): fade the halo by stamping rings
      // of falling alpha.
      const bare = ctx as Canvas2D;
      for (let ring = 1; ring <= 3; ring++) {
        bare.globalAlpha = 0.5 / ring;
        stampAround(bare, sil, (width * ring) / 2);
      }
      bare.globalAlpha = 1;
    }
  } else {
    // Contour styles.
    const rings = contoursOf(silhouette, w, h);
    if (stroke.style === "dotted") {
      const gap = Math.max(width * 2.6, 6);
      for (const ring of rings) {
        for (const p of resampleRing(ring, gap)) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, width / 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else if (stroke.style === "cut") {
      // Coarse polygon: the sticker-scissors look.
      ctx.lineWidth = width;
      ctx.lineJoin = "miter";
      for (const ring of rings) {
        const poly = simplifyRing(ring, Math.max(6, Math.min(w, h) * 0.02));
        if (poly.length < 3) continue;
        ctx.beginPath();
        ctx.moveTo(poly[0].x, poly[0].y);
        for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
        ctx.closePath();
        ctx.stroke();
      }
    } else {
      // Hand drawn: the boundary resampled and jittered by two sinusoids that
      // drift with time, so the line boils the way a drawn-on-frames outline
      // does.
      ctx.lineWidth = Math.max(1.5, width * 0.6);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      const amp = Math.max(1.5, width * 0.5);
      const phase = t * 2.1;
      for (const ring of rings) {
        const pts = resampleRing(ring, Math.max(6, amp * 2.2));
        if (pts.length < 3) continue;
        ctx.beginPath();
        for (let i = 0; i <= pts.length; i++) {
          const p = pts[i % pts.length];
          const wob = Math.sin(i * 0.9 + phase) * amp + Math.sin(i * 0.37 - phase * 0.7) * amp * 0.5;
          const x = p.x + Math.cos(i * 0.53 + phase) * wob * 0.4;
          const y = p.y + Math.sin(i * 0.71 - phase) * wob * 0.4 + wob * 0.3;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}
