/**
 * Masks: per-layer coverage that trims a layer's pixels to a shape — a
 * rounded rect, an ellipse, a half-plane, a band, a heart, a star, a polygon,
 * a pen-drawn outline — or to the person in the shot. The mask travels with its layer: its center is an offset from the
 * layer's anchor, so a keyframed or dragged layer carries its mask along in
 * every renderer.
 *
 * One painter produces every mask pixel. The DOM preview turns its output
 * into a CSS mask-image, the canvas compositors multiply it into a layer's
 * alpha, and the ffmpeg export consumes it as client-painted grayscale
 * pictures — so the three render paths cannot disagree about coverage.
 *
 * `kind: "subject"` has no geometry of its own: coverage is the person matte
 * the host computes (MediaPipe live, a mask video for export). The painter
 * skips it; hosts composite it through the same alpha-multiply seam.
 */

import { lerpKeys, shortestTurn } from "./keys";
import { shapePathD, tracePolyShape } from "./shapePath";
import type { ShapeKind } from "./types";

export type MaskKind =
  | "rect"
  | "square"
  | "circle"
  | "linear"
  | "mirror"
  | "heart"
  | "star"
  | "triangle"
  | "diamond"
  | "hexagon"
  | "pen"
  | "subject";

/** Every mask kind with the name the UI shows for it, in picker order. The
 * shape picker, the chat tool's enum and the catalog all read this list. */
export const MASK_SHAPES: { id: MaskKind; label: string }[] = [
  { id: "rect", label: "Rectangle" },
  { id: "square", label: "Square" },
  { id: "circle", label: "Circle" },
  { id: "linear", label: "Linear" },
  { id: "mirror", label: "Mirror" },
  { id: "heart", label: "Heart" },
  { id: "star", label: "Star" },
  { id: "triangle", label: "Triangle" },
  { id: "diamond", label: "Diamond" },
  { id: "hexagon", label: "Hexagon" },
  { id: "pen", label: "Pen" },
  { id: "subject", label: "Subject" },
];

export const MASK_KINDS: MaskKind[] = MASK_SHAPES.map((s) => s.id);

/** The geometric kinds: everything with an outline of its own. */
export const MASK_SHAPE_KINDS: MaskKind[] = MASK_KINDS.filter((k) => k !== "subject");

/** Feather ceiling, design px at the 1080 short side. */
export const MASK_FEATHER_MAX = 200;
/** Corner radius ceiling for rect and square masks, design px. */
export const MASK_RADIUS_MAX = 400;

/** The polygon outline a mask kind traces, for the kinds that share the shape
 * element's tracer; null for the box, ellipse, band and matte kinds. */
export function maskPolyKind(kind: MaskKind): ShapeKind | null {
  switch (kind) {
    case "heart":
    case "star":
    case "triangle":
    case "diamond":
    case "hexagon":
      return kind;
    default:
      return null;
  }
}

/** One corner of a pen mask's outline, as an offset from the mask's center
 * in fractions of its w × h box: (−0.5, −0.5) is the box's top-left corner.
 * The box carries the outline, so the mask's position, size, rotation and
 * keys move the drawing as one piece. */
export interface MaskPoint {
  x: number;
  y: number;
}

/** The fewest corners a pen outline closes with. */
export const PEN_MIN_POINTS = 3;

/** Whether a pen mask has an outline to cut with. Short of that the mask is
 * still being drawn and the whole picture shows. */
export function penClosed(m: Mask): boolean {
  return m.kind === "pen" && (m.points?.length ?? 0) >= PEN_MIN_POINTS;
}

/** Whether the mask keeps the outside of its coverage. A pen outline still
 * being drawn shows the whole picture whichever way the toggle sits, so the
 * corners land on what the user sees. */
export function maskInverts(m: Mask): boolean {
  return !!m.invert && !(m.kind === "pen" && !penClosed(m));
}

/** Trace a pen outline into `sink`, its box w × h px centered on (dx, dy). */
export function tracePen(
  sink: { moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; closePath(): void },
  points: MaskPoint[],
  w: number,
  h: number,
  dx = 0,
  dy = 0
): void {
  points.forEach((p, i) => {
    const x = dx + p.x * w;
    const y = dy + p.y * h;
    if (i === 0) sink.moveTo(x, y);
    else sink.lineTo(x, y);
  });
  sink.closePath();
}

/** Which size axes a kind has: a square one side, a mirror band one height,
 * a linear edge none, every filled outline both. */
export function maskSizeAxes(kind: MaskKind): ("w" | "h")[] {
  switch (kind) {
    case "square":
      return ["w"];
    case "mirror":
      return ["h"];
    case "linear":
    case "subject":
      return [];
    default:
      return ["w", "h"];
  }
}

/** Whether a kind takes a corner radius. */
export function maskHasRadius(kind: MaskKind): boolean {
  return kind === "rect" || kind === "square";
}

/** The hard edge of a mask's shape as SVG path data, centered on the origin
 * (offset by dx, dy) in the mask's own unrotated space, from the same
 * geometry the painter fills. A linear edge is a line across `span`, a
 * mirror band two of them. */
export function maskOutlinePathD(
  m: Mask,
  w: number,
  h: number,
  span: number,
  radiusPx = 0,
  dx = 0,
  dy = 0
): string {
  const n = (v: number) => String(+v.toFixed(2));
  const side = m.kind === "square" ? w : h;
  const poly = maskPolyKind(m.kind);
  if (poly) return shapePathD(poly, w, h, dx - w / 2, dy - h / 2);
  if (m.kind === "pen") {
    if (!penClosed(m)) return "";
    const parts: string[] = [];
    tracePen(
      {
        moveTo: (x, y) => parts.push(`M${n(x)} ${n(y)}`),
        lineTo: (x, y) => parts.push(`L${n(x)} ${n(y)}`),
        closePath: () => parts.push("Z"),
      },
      m.points!,
      w,
      h,
      dx,
      dy
    );
    return parts.join(" ");
  }
  if (m.kind === "rect" || m.kind === "square") {
    const r = Math.min(radiusPx, w / 2, side / 2);
    const x0 = dx - w / 2;
    const y0 = dy - side / 2;
    if (r <= 0) return `M${n(x0)} ${n(y0)} h${n(w)} v${n(side)} h${n(-w)} Z`;
    return (
      `M${n(x0 + r)} ${n(y0)} h${n(w - 2 * r)} a${n(r)} ${n(r)} 0 0 1 ${n(r)} ${n(r)} ` +
      `v${n(side - 2 * r)} a${n(r)} ${n(r)} 0 0 1 ${n(-r)} ${n(r)} h${n(-(w - 2 * r))} ` +
      `a${n(r)} ${n(r)} 0 0 1 ${n(-r)} ${n(-r)} v${n(-(side - 2 * r))} a${n(r)} ${n(r)} 0 0 1 ${n(r)} ${n(-r)} Z`
    );
  }
  if (m.kind === "circle") {
    const rx = w / 2;
    const ry = h / 2;
    return (
      `M${n(dx - rx)} ${n(dy)} a${n(rx)} ${n(ry)} 0 1 0 ${n(2 * rx)} 0 ` +
      `a${n(rx)} ${n(ry)} 0 1 0 ${n(-2 * rx)} 0 Z`
    );
  }
  if (m.kind === "linear") return `M${n(dx - span)} ${n(dy)} H${n(dx + span)}`;
  if (m.kind === "mirror")
    return `M${n(dx - span)} ${n(dy - h / 2)} H${n(dx + span)} M${n(dx - span)} ${n(dy + h / 2)} H${n(dx + span)}`;
  return "";
}

/** One keyed state of a mask's geometry, `t` seconds from the layer's start.
 * Same interpolation rules as the pose track: linear between keys, held flat
 * outside them. */
export interface MaskKey {
  t: number;
  x: number; // center offset from the layer anchor, fraction of frame width
  y: number; // center offset, fraction of frame height
  w: number; // fraction of frame width (square: the side; linear/mirror ignore)
  h: number; // fraction of frame height (mirror: band height; square/linear ignore)
  rotation: number; // degrees clockwise
  feather: number; // edge softness, px at the 1080 design short side
  /** Box corner radius, design px; absent = the mask's own. */
  radius?: number;
}

export interface Mask {
  kind: MaskKind;
  /** Center offset from the layer anchor, frame fractions; absent = centered
   * on the layer. An offset keeps the mask riding the layer's pose. */
  x?: number;
  y?: number;
  /** Size, frame fractions; absent = 0.5. */
  w?: number;
  h?: number;
  /** Degrees clockwise; for linear/mirror this angles the edge line. */
  rotation?: number;
  /** Edge softness, design px; absent = hard edge. */
  feather?: number;
  /** Keep the pixels outside the shape (or outside the person). */
  invert?: boolean;
  /** Rect or square corner radius, design px; a key can carry its own. */
  radius?: number;
  /** A pen mask's corners, in order around the outline. Fewer than
   * PEN_MIN_POINTS means the outline is still being drawn. */
  points?: MaskPoint[];
  /** Keyframed geometry, its own track beside the layer's pose keys. */
  kf?: MaskKey[];
}

/** The mask's resolved geometry at one moment. */
export interface MaskFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  feather: number;
  radius: number;
}

export function restingMaskFrame(m: Mask): MaskFrame {
  // A pen outline is drawn in frame space, so its box starts as the frame.
  const size = m.kind === "pen" ? 1 : 0.5;
  return {
    x: m.x ?? 0,
    y: m.y ?? 0,
    w: m.w ?? size,
    h: m.h ?? size,
    rotation: m.rotation ?? 0,
    feather: m.feather ?? 0,
    radius: m.radius ?? 0,
  };
}

export function hasMaskKeys(m?: Mask): boolean {
  return !!m?.kf && m.kf.length > 0;
}

/** Whether the mask's pixels change over time on their own. */
export function isMaskAnimated(m?: Mask): boolean {
  return hasMaskKeys(m);
}

/** A mask that puts its layer behind the person in the shot — the shape the
 * behind-speaker feature migrates into. */
export function behindSubjectMask(m?: Mask): boolean {
  return !!m && m.kind === "subject" && !!m.invert;
}

/** The mask's geometry at `tLocal` seconds into the layer: interpolated
 * between keys, held flat outside them, resting when there are none. */
export function maskFrameAt(m: Mask, tLocal: number): MaskFrame {
  if (!m.kf || m.kf.length === 0) return restingMaskFrame(m);
  const rest = m.radius ?? 0;
  const k = lerpKeys(m.kf, tLocal, (a, b, p) => {
    const mix = (u: number, v: number) => u + (v - u) * p;
    return {
      t: mix(a.t, b.t),
      x: mix(a.x, b.x),
      y: mix(a.y, b.y),
      w: mix(a.w, b.w),
      h: mix(a.h, b.h),
      rotation: a.rotation + shortestTurn(a.rotation, b.rotation) * p,
      feather: mix(a.feather, b.feather),
      radius: mix(a.radius ?? rest, b.radius ?? rest),
    };
  });
  return {
    x: k.x,
    y: k.y,
    w: k.w,
    h: k.h,
    rotation: k.rotation,
    feather: k.feather,
    radius: k.radius ?? rest,
  };
}

/** A key holding the mask's geometry at `t`, ready to be added — capturing
 * the live frame keeps the first key a visual no-op. */
export function maskKeyAt(m: Mask, t: number): MaskKey {
  const { radius, ...f } = maskFrameAt(m, t);
  return maskHasRadius(m.kind) ? { t, ...f, radius } : { t, ...f };
}

/** The frame geometry the painter needs: output size plus the design-px
 * scale (min(width, height) / 1080). Matches render.ts's PaintFrame. */
interface MaskPaintFrame {
  width: number;
  height: number;
  scale: number;
}

/** Painters run on plain and offscreen canvases alike. */
type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Wider than any rotated frame diagonal, for the unbounded fills. */
function bigSpan(frame: MaskPaintFrame): number {
  return (frame.width + frame.height) * 2;
}

/**
 * Paint the mask's coverage — white where the layer keeps its pixels, before
 * `invert` is considered — into `ctx` under its current transform. `anchor`
 * is the layer's anchor in frame fractions; the mask centers at anchor plus
 * its own offset. Skips `kind: "subject"` (the host owns that matte).
 */
export function paintMaskCoverage(
  ctx: Canvas2D,
  m: Mask,
  tLocal: number,
  frame: MaskPaintFrame,
  anchor: { x: number; y: number }
): void {
  if (m.kind === "subject") return;
  const f = maskFrameAt(m, tLocal);
  const cx = (anchor.x + f.x) * frame.width;
  const cy = (anchor.y + f.y) * frame.height;
  const w = Math.max(1, f.w * frame.width);
  const h = Math.max(1, f.h * frame.height);
  const feather = Math.max(0, f.feather * frame.scale);
  const big = bigSpan(frame);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((f.rotation * Math.PI) / 180);
  ctx.fillStyle = "#ffffff";
  if (m.kind === "rect" || m.kind === "square") {
    // Soft edges come from a gaussian of the hard shape; σ = feather / 2 puts
    // the visible transition at about the feather width. A square's side is
    // `w` of the frame width on both axes, so it stays square in pixels on
    // any aspect.
    const rh = m.kind === "square" ? w : h;
    if (feather > 0 && "filter" in ctx) ctx.filter = `blur(${feather / 2}px)`;
    ctx.beginPath();
    ctx.roundRect(-w / 2, -rh / 2, w, rh, Math.max(0, f.radius) * frame.scale);
    ctx.fill();
  } else if (m.kind === "circle") {
    if (feather > 0 && "filter" in ctx) ctx.filter = `blur(${feather / 2}px)`;
    ctx.beginPath();
    ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (maskPolyKind(m.kind)) {
    // The shape element's own outline, filled into the w×h box.
    if (feather > 0 && "filter" in ctx) ctx.filter = `blur(${feather / 2}px)`;
    ctx.beginPath();
    tracePolyShape(ctx, maskPolyKind(m.kind)!, w, h, -w / 2, -h / 2);
    ctx.fill();
  } else if (m.kind === "pen") {
    // The drawn outline filled into the w×h box. While it is still being
    // drawn the whole picture shows, so the user draws over what they see.
    if (!penClosed(m)) {
      ctx.fillRect(-big, -big, big * 2, big * 2);
    } else {
      if (feather > 0 && "filter" in ctx) ctx.filter = `blur(${feather / 2}px)`;
      ctx.beginPath();
      tracePen(ctx, m.points!, w, h);
      ctx.fill();
    }
  } else if (m.kind === "linear") {
    // Half-plane: at rotation 0 the top half stays. The gradient band spans
    // the feather, centered on the edge line.
    if (feather > 0) {
      const g = ctx.createLinearGradient(0, -feather / 2, 0, feather / 2);
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(-big, -feather / 2, big * 2, feather);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(-big, -big, big * 2, big - feather / 2);
    } else {
      ctx.fillRect(-big, -big, big * 2, big);
    }
  } else if (m.kind === "mirror") {
    // A band of height `h` centered on the line; both edges feathered. The
    // feather never exceeds the band, so the center stays solid.
    const fe = Math.min(feather, h);
    if (fe > 0) {
      const top = ctx.createLinearGradient(0, -h / 2 - fe / 2, 0, -h / 2 + fe / 2);
      top.addColorStop(0, "rgba(255,255,255,0)");
      top.addColorStop(1, "rgba(255,255,255,1)");
      ctx.fillStyle = top;
      ctx.fillRect(-big, -h / 2 - fe / 2, big * 2, fe);
      const bottom = ctx.createLinearGradient(0, h / 2 - fe / 2, 0, h / 2 + fe / 2);
      bottom.addColorStop(0, "rgba(255,255,255,1)");
      bottom.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = bottom;
      ctx.fillRect(-big, h / 2 - fe / 2, big * 2, fe);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(-big, -h / 2 + fe / 2, big * 2, Math.max(0, h - fe));
    } else {
      ctx.fillRect(-big, -h / 2, big * 2, h);
    }
  }
  ctx.restore();
}

/**
 * Paint the mask as a luma picture — white keeps the pixel, black drops it,
 * with `invert` already baked in — for a box cut out of the frame whose
 * top-left sits at (boxX, boxY) in frame px. The canvas is box-sized and
 * fully opaque, so encoders and ffmpeg's gray conversion read the feather
 * from luma. This is what the export's mask stills sample.
 */
export function paintMaskLuma(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  m: Mask,
  tLocal: number,
  frame: MaskPaintFrame,
  anchor: { x: number; y: number },
  boxX: number,
  boxY: number
): void {
  const ctx = canvas.getContext("2d") as Canvas2D | null;
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  // Inverted: a white ground with the coverage differenced out of it, so a
  // feathered edge reads as 1 − coverage. Plain: coverage over black.
  const invert = maskInverts(m);
  ctx.fillStyle = invert ? "#ffffff" : "#000000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (invert) ctx.globalCompositeOperation = "difference";
  ctx.translate(-boxX, -boxY);
  paintMaskCoverage(ctx, m, tLocal, frame, anchor);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
}

/**
 * Multiply `coverage`'s alpha into `target` at identity transform: keep the
 * covered pixels, or the uncovered ones when inverted. `coverage` must match
 * the target's pixel size.
 */
export function maskComposite(
  target: Canvas2D,
  coverage: CanvasImageSource,
  invert?: boolean
): void {
  target.save();
  target.setTransform(1, 0, 0, 1, 0, 0);
  target.globalAlpha = 1;
  target.globalCompositeOperation = invert ? "destination-out" : "destination-in";
  target.drawImage(coverage, 0, 0);
  target.restore();
}

/**
 * Trim `target`'s pixels to the mask: paint coverage into `scratch` (sized to
 * match) under `transform` — the same transform the layer's pixels were drawn
 * with, so the mask rides the layer — then composite. Subject masks return
 * untouched; the host composites its matte through `maskComposite` itself.
 */
export function applyMaskToCanvas(
  target: Canvas2D,
  scratch: HTMLCanvasElement | OffscreenCanvas,
  m: Mask,
  tLocal: number,
  frame: MaskPaintFrame,
  anchor: { x: number; y: number },
  transform?: DOMMatrix
): void {
  if (m.kind === "subject") return;
  const tw = target.canvas.width;
  const th = target.canvas.height;
  if (scratch.width !== tw) scratch.width = tw;
  if (scratch.height !== th) scratch.height = th;
  const sctx = scratch.getContext("2d") as Canvas2D;
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, tw, th);
  if (transform) sctx.setTransform(transform);
  paintMaskCoverage(sctx, m, tLocal, frame, anchor);
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  maskComposite(target, scratch as CanvasImageSource, maskInverts(m));
}
