/**
 * Canvas painters: rasterize any overlay element to a transparent full-frame
 * PNG at the export resolution, with the same metrics the host's DOM preview
 * uses. The host supplies a RenderEnv for everything it owns — font stacks and
 * sticker image bytes — so painters stay host-agnostic.
 */

import {
  FLOAT_TRAVEL,
  loopPeriod,
  SLIDE_TRAVEL,
  type OverlayAnim,
  type OverlayAnimStyle,
} from "./anim";
import { evalOverlayFrame, hasOverlayKeys, poseAt, poseExtent, sortedKeys } from "./keys";
import { applyMaskToCanvas, isMaskAnimated } from "./mask";
import type { LottieHandle } from "./lottie";
import { elementPlugin } from "./registry";
import {
  lineLikeShape,
  type Overlay,
  type ShapeKind,
  type ShapeOverlay,
  type StickerOverlay,
  type TextOverlay,
  type TextShadowSpec,
} from "./types";

// Text metrics shared by DOM preview and canvas burn-in.
export const LINE_HEIGHT = 1.25;
export const PLATE_PAD_X = 0.55; // em
export const PLATE_PAD_Y = 0.3; // em
export const PLATE_RADIUS = 0.32; // em
export const PLATE_COLOR = "#000000";
export const PLATE_OPACITY = 0.55;
export const PLATE_FILL = "rgba(0, 0, 0, 0.55)";
export const SHADOW = { color: "rgba(0, 0, 0, 0.65)", blur: 14, offsetY: 2 };

/** A hex color with an opacity folded in, as rgba(); non-hex input falls back
 * to black at that opacity. */
function rgba(hex: string, opacity: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return `rgba(0, 0, 0, ${opacity})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${opacity})`;
}

/** A text element's plate fill as an rgba() string, defaulting to translucent
 * black when color/opacity are unset. Shared by preview and export. */
export function plateFill(o: { plateColor?: string; plateOpacity?: number }): string {
  return rgba(o.plateColor ?? PLATE_COLOR, o.plateOpacity ?? PLATE_OPACITY);
}

/** Resolve a text element's shadow to concrete design-px values, or null when
 * it is off. `true` and `{}` both mean the legacy default look. */
export function resolveShadow(
  shadow: boolean | TextShadowSpec
): { color: string; blur: number; offsetY: number } | null {
  if (shadow === false) return null;
  const spec: TextShadowSpec = shadow === true ? {} : shadow;
  return {
    color: rgba(spec.color ?? "#000000", spec.opacity ?? 0.65),
    blur: spec.blur ?? SHADOW.blur,
    offsetY: spec.offsetY ?? SHADOW.offsetY,
  };
}

/** Await the faces a text element needs before measuring or painting, so a
 * rasterize never silently measures a fallback font. No-op outside the DOM. */
export async function ensureFontLoaded(cssFont: string, text?: string): Promise<void> {
  if (typeof document === "undefined" || !document.fonts?.load) return;
  try {
    await document.fonts.load(cssFont, text);
  } catch {
    // An unknown family or a blocked face falls back; painting proceeds.
  }
}

/** A decoded sticker image with its natural size (for aspect). */
export interface StickerImage {
  source: CanvasImageSource;
  width: number;
  height: number;
}

/** What the host supplies so painters can resolve host-owned resources. */
export interface RenderEnv {
  /** CSS font-family stack for a host font id. */
  fontStack(font: string): string;
  /** Decoded image for a sticker asset id; null when the asset is gone. */
  resolveAsset?(assetId: string): Promise<StickerImage | null>;
  /** Seekable player for a Lottie sticker asset id; null when the asset is
   * gone or isn't a Lottie document. */
  resolveLottie?(assetId: string): Promise<LottieHandle | null>;
}

/** The frame geometry handed to painters. `scale` converts design px (1080
 * short side) to output px. `t` is seconds since the element's start, for
 * painters whose pixels are time-dependent (Lottie stickers). */
export interface PaintFrame {
  width: number;
  height: number;
  scale: number;
  t?: number;
}

/**
 * A shape's pixel geometry in the output frame — the one place the fractions
 * become pixels, shared by the canvas painter and testable on its own.
 * Line/arrow thickness rides the shape's `h`; the arrow head scales with the
 * thickness but never eats more than half the length.
 */
export function shapeMetrics(o: ShapeOverlay, frame: PaintFrame) {
  const cx = o.x * frame.width;
  const cy = o.y * frame.height;
  const w = Math.max(1, o.w * frame.width);
  const h = Math.max(1, o.h * frame.height);
  const thickness = Math.max(2 * frame.scale, h);
  const headLen = Math.min(thickness * 3, w / 2);
  return {
    cx,
    cy,
    w,
    h,
    radius: (o.radius ?? 0) * frame.scale,
    strokeWidth: (o.stroke?.width ?? 0) * frame.scale,
    thickness,
    headLen,
    headHalf: thickness * 1.6,
  };
}

/** A path consumer — a canvas context is one, and `shapePathD` builds SVG
 * path data through the same calls, so both draw identical geometry. */
export interface ShapePathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
  closePath(): void;
}

/** Trace a polygon shape's outline into a w×h box whose top-left corner sits
 * at (dx, dy). Covers the filled kinds beyond rect and ellipse. */
export function tracePolyShape(
  p: ShapePathSink,
  kind: ShapeKind,
  w: number,
  h: number,
  dx = 0,
  dy = 0
) {
  const X = (f: number) => dx + f * w;
  const Y = (f: number) => dy + f * h;
  if (kind === "triangle") {
    p.moveTo(X(0.5), Y(0));
    p.lineTo(X(1), Y(1));
    p.lineTo(X(0), Y(1));
  } else if (kind === "diamond") {
    p.moveTo(X(0.5), Y(0));
    p.lineTo(X(1), Y(0.5));
    p.lineTo(X(0.5), Y(1));
    p.lineTo(X(0), Y(0.5));
  } else if (kind === "hexagon") {
    // Lucide's hexagon stands on a point: vertices top and bottom, straight
    // vertical sides.
    p.moveTo(X(0.5), Y(0));
    p.lineTo(X(1), Y(0.25));
    p.lineTo(X(1), Y(0.75));
    p.lineTo(X(0.5), Y(1));
    p.lineTo(X(0), Y(0.75));
    p.lineTo(X(0), Y(0.25));
  } else if (kind === "star") {
    // Lucide's star: the inner ring at half the outer radius so the points
    // read full-bodied, and rounded corners — a soft round in each inner
    // notch, a slight one at each tip. Each corner is cut short along its
    // two edges and bridged by a cubic whose controls sit on the vertex.
    const pts: [number, number][] = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 0.5 : 1;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      pts.push([0.5 + 0.5 * r * Math.cos(a), 0.5 + 0.5 * r * Math.sin(a)]);
    }
    for (let i = 0; i < 10; i++) {
      const [px, py] = pts[(i + 9) % 10];
      const [cx, cy] = pts[i];
      const [nx, ny] = pts[(i + 1) % 10];
      const cut = i % 2 ? 0.35 : 0.15;
      const ex = cx + (px - cx) * cut;
      const ey = cy + (py - cy) * cut;
      const lx = cx + (nx - cx) * cut;
      const ly = cy + (ny - cy) * cut;
      if (i === 0) p.moveTo(X(ex), Y(ey));
      else p.lineTo(X(ex), Y(ey));
      p.bezierCurveTo(X(cx), Y(cy), X(cx), Y(cy), X(lx), Y(ly));
    }
  } else if (kind === "heart") {
    // Lucide's heart, normalized to the unit box (its arcs as cubics):
    // straight sides down to the tip, round quarter-circle lobes on top.
    p.moveTo(X(0.5), Y(1));
    p.lineTo(X(0.15), Y(0.611));
    p.bezierCurveTo(X(0.075), Y(0.531), X(0), Y(0.433), X(0), Y(0.306));
    p.bezierCurveTo(X(0), Y(0.137), X(0.123), Y(0), X(0.275), Y(0));
    p.bezierCurveTo(X(0.363), Y(0), X(0.425), Y(0.028), X(0.5), Y(0.111));
    p.bezierCurveTo(X(0.575), Y(0.028), X(0.637), Y(0), X(0.725), Y(0));
    p.bezierCurveTo(X(0.877), Y(0), X(1), Y(0.137), X(1), Y(0.306));
    p.bezierCurveTo(X(1), Y(0.433), X(0.925), Y(0.531), X(0.85), Y(0.611));
  }
  p.closePath();
}

/** A polygon shape as SVG path data for a w×h box, for the DOM preview. */
export function shapePathD(kind: ShapeKind, w: number, h: number): string {
  const parts: string[] = [];
  const n = (v: number) => String(+v.toFixed(2));
  tracePolyShape(
    {
      moveTo: (x, y) => parts.push(`M${n(x)} ${n(y)}`),
      lineTo: (x, y) => parts.push(`L${n(x)} ${n(y)}`),
      bezierCurveTo: (c1x, c1y, c2x, c2y, x, y) =>
        parts.push(`C${n(c1x)} ${n(c1y)} ${n(c2x)} ${n(c2y)} ${n(x)} ${n(y)}`),
      closePath: () => parts.push("Z"),
    },
    kind,
    w,
    h
  );
  return parts.join(" ");
}

function paintShape(ctx: CanvasRenderingContext2D, o: ShapeOverlay, frame: PaintFrame) {
  const m = shapeMetrics(o, frame);
  const alpha = ctx.globalAlpha;
  ctx.fillStyle = o.fill;
  if (!lineLikeShape(o.shape)) {
    ctx.beginPath();
    if (o.shape === "rect") {
      ctx.roundRect(m.cx - m.w / 2, m.cy - m.h / 2, m.w, m.h, m.radius);
    } else if (o.shape === "ellipse") {
      ctx.ellipse(m.cx, m.cy, m.w / 2, m.h / 2, 0, 0, Math.PI * 2);
    } else {
      tracePolyShape(ctx, o.shape, m.w, m.h, m.cx - m.w / 2, m.cy - m.h / 2);
    }
    ctx.globalAlpha = alpha * (o.fillOpacity ?? 1);
    ctx.fill();
    ctx.globalAlpha = alpha;
    if (o.stroke && m.strokeWidth > 0) {
      ctx.strokeStyle = o.stroke.color;
      ctx.lineWidth = m.strokeWidth;
      ctx.lineJoin = "round";
      ctx.stroke();
    }
    return;
  }
  // Line / arrow: a horizontal stroke across the element box; rotation (the
  // generic element transform) gives it any direction.
  const x0 = m.cx - m.w / 2;
  const x1 = m.cx + m.w / 2;
  ctx.strokeStyle = o.fill;
  ctx.lineWidth = m.thickness;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x0, m.cy);
  ctx.lineTo(o.shape === "arrow" ? x1 - m.headLen : x1, m.cy);
  ctx.stroke();
  if (o.shape === "arrow") {
    ctx.fillStyle = o.fill;
    ctx.beginPath();
    ctx.moveTo(x1, m.cy);
    ctx.lineTo(x1 - m.headLen, m.cy - m.headHalf);
    ctx.lineTo(x1 - m.headLen, m.cy + m.headHalf);
    ctx.closePath();
    ctx.fill();
  }
}

async function paintSticker(
  ctx: CanvasRenderingContext2D,
  o: StickerOverlay,
  frame: PaintFrame,
  env: RenderEnv
) {
  const cx = o.x * frame.width;
  const cy = o.y * frame.height;
  const w = Math.max(1, o.w * frame.width);
  if (!o.assetId) return;
  if (o.lottie) {
    const handle = await env.resolveLottie?.(o.assetId);
    if (!handle) return;
    const aspect = handle.width > 0 && handle.height > 0 ? handle.width / handle.height : 1;
    const h = w / aspect;
    ctx.drawImage(handle.seek(frame.t ?? 0), cx - w / 2, cy - h / 2, w, h);
    return;
  }
  if (!env.resolveAsset) return;
  const img = await env.resolveAsset(o.assetId);
  if (!img) return;
  const aspect = img.width > 0 && img.height > 0 ? img.width / img.height : 1;
  const h = w / aspect;
  ctx.drawImage(img.source, cx - w / 2, cy - h / 2, w, h);
}

/** The CSS font shorthand a text element paints (and loads faces) with. */
export function textCssFont(overlay: TextOverlay, fpx: number, env: RenderEnv): string {
  return `${overlay.italic ? "italic " : ""}${overlay.weight} ${fpx}px ${env.fontStack(overlay.font)}`;
}

async function paintText(
  ctx: CanvasRenderingContext2D,
  overlay: TextOverlay,
  frame: PaintFrame,
  env: RenderEnv
) {
  const { width, scale } = frame;
  const fpx = overlay.size * scale;
  const cssFont = textCssFont(overlay, fpx, env);
  // Faces must be resident before measureText, or the plate and alignment are
  // measured against a fallback font and the burn-in drifts off the preview.
  await ensureFontLoaded(cssFont, overlay.text);
  ctx.font = cssFont;
  if ("letterSpacing" in ctx) {
    ctx.letterSpacing = `${(overlay.letterSpacing ?? 0) * fpx}px`;
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const lines = overlay.text.split("\n");
  const lineH = fpx * (overlay.lineHeight ?? LINE_HEIGHT);
  const totalH = lines.length * lineH;
  const cx = overlay.x * width;
  const cy = overlay.y * frame.height;
  const widthsOf = lines.map((l) => ctx.measureText(l).width);
  const maxW = Math.max(...widthsOf, 1);

  if (overlay.plate) {
    const padX = PLATE_PAD_X * fpx;
    const padY = PLATE_PAD_Y * fpx;
    const r = (overlay.plateRadius ?? PLATE_RADIUS) * fpx;
    const w = maxW + padX * 2;
    const h = totalH + padY * 2;
    ctx.fillStyle = plateFill(overlay);
    ctx.beginPath();
    ctx.roundRect(cx - w / 2, cy - h / 2, w, h, r);
    ctx.fill();
  }

  const shadow = resolveShadow(overlay.shadow);
  if (shadow) {
    ctx.shadowColor = shadow.color;
    ctx.shadowBlur = shadow.blur * scale;
    ctx.shadowOffsetY = shadow.offsetY * scale;
  }

  // Outline behind the fill: stroke first, then fill over it — the same order
  // the DOM pair (-webkit-text-stroke + paint-order: stroke fill) paints.
  const strokeW = (overlay.stroke?.width ?? 0) * fpx;
  const drawText = (text: string, x: number, y: number, fill: string = overlay.color) => {
    if (overlay.stroke && strokeW > 0) {
      ctx.lineJoin = "round";
      ctx.lineWidth = strokeW * 2; // half of a centered stroke shows behind the fill
      ctx.strokeStyle = overlay.stroke.color;
      ctx.strokeText(text, x, y);
    }
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  };

  // Line alignment inside the block; the block stays centered on (x, y).
  const align = overlay.align ?? "center";
  const lineX = (i: number) =>
    align === "center"
      ? cx
      : align === "left"
        ? cx - maxW / 2 + widthsOf[i] / 2
        : cx + maxW / 2 - widthsOf[i] / 2;

  // Karaoke: draw word by word so the spoken word gets the accent color and an
  // underline; the word index counts across all lines.
  let k = 0;
  lines.forEach((line, i) => {
    const y = cy - totalH / 2 + lineH * (i + 0.5);
    if (overlay.highlightWord === undefined) {
      drawText(line, lineX(i), y);
      return;
    }
    const words = line.split(" ").filter(Boolean);
    const spaceW = ctx.measureText(" ").width;
    const widths = words.map((w) => ctx.measureText(w).width);
    const lineW = widths.reduce((a, b) => a + b, 0) + spaceW * (words.length - 1);
    let x = cx - lineW / 2;
    ctx.textAlign = "left";
    words.forEach((w, wi) => {
      const active = k === overlay.highlightWord;
      if (active && overlay.highlightMode === "box") {
        // Accent box behind the word, contrast text on top — drawn with the
        // shadow off so the box and its word stay crisp.
        const pad = 0.12 * fpx;
        const prevShadow = ctx.shadowColor;
        ctx.shadowColor = "transparent";
        ctx.fillStyle = overlay.highlightColor ?? "#FFE94A";
        ctx.beginPath();
        ctx.roundRect(x - pad, y - fpx * 0.5 - pad, widths[wi] + pad * 2, fpx + pad * 2, 0.18 * fpx);
        ctx.fill();
        drawText(w, x, y, overlay.highlightText ?? "#111114");
        ctx.shadowColor = prevShadow;
      } else if (active) {
        drawText(w, x, y, overlay.highlightColor ?? "#FFE94A");
        if (overlay.highlightMode !== "color") {
          ctx.fillRect(x, y + fpx * 0.42, widths[wi], Math.max(2 * scale, fpx * 0.07));
        }
      } else {
        drawText(w, x, y);
      }
      x += widths[wi] + spaceW;
      k++;
    });
    ctx.textAlign = "center";
  });
}

/** Paint one element in frame coordinates with no element-level transform —
 * the raw painter dispatch. Callers own rotation/opacity (renderElementPng)
 * or the full animation transform (renderOverlayFrames). */
export async function paintElement(
  ctx: CanvasRenderingContext2D,
  overlay: Overlay,
  frame: PaintFrame,
  env: RenderEnv
): Promise<void> {
  const kind = overlay.kind ?? "text";
  if (kind === "effect") return; // effects filter the video; nothing to paint
  const plugin = elementPlugin(kind);
  if (plugin) {
    await plugin.paint(ctx, overlay, frame, env);
  } else if (kind === "shape") {
    paintShape(ctx, overlay as ShapeOverlay, frame);
  } else if (kind === "sticker") {
    await paintSticker(ctx, overlay as StickerOverlay, frame, env);
  } else {
    await paintText(ctx, overlay as TextOverlay, frame, env);
  }
}

function pngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Could not render the overlay."))),
      "image/png"
    )
  );
}

/**
 * Rasterize one element to a transparent full-frame PNG at the given output
 * size. Rotation and opacity apply here, around the element center, so every
 * painter draws unrotated in frame coordinates.
 */
export async function renderElementPng(
  overlay: Overlay,
  width: number,
  height: number,
  env: RenderEnv
): Promise<Blob> {
  // Element sizes are design pixels with a 1080 short side, so scaling by the
  // short side keeps them the same visual size in any aspect and resolution.
  const scale = Math.min(width, height) / 1080;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const frame: PaintFrame = { width, height, scale };

  ctx.globalAlpha = overlay.opacity ?? 1;
  if (overlay.rotation) {
    const cx = overlay.x * width;
    const cy = overlay.y * height;
    ctx.translate(cx, cy);
    ctx.rotate((overlay.rotation * Math.PI) / 180);
    ctx.translate(-cx, -cy);
  }

  await paintElement(ctx, overlay, frame, env);
  if (overlay.mask) {
    // The mask is painted under the element's own transform, so it rotates
    // and travels with the element. A keyframed mask routes through the
    // animated frame sampler; here its resting (first) geometry applies.
    applyMaskToCanvas(
      ctx,
      document.createElement("canvas"),
      overlay.mask,
      0,
      frame,
      { x: overlay.x, y: overlay.y },
      ctx.getTransform()
    );
  }
  return pngBlob(canvas);
}

/** An element's resting box in output pixels (center + size), rotation left
 * to the caller. Conservative on purpose: it feeds the animated-region crop,
 * where a few spare pixels beat a clipped shadow. */
export async function measureElementBounds(
  overlay: Overlay,
  frame: PaintFrame,
  env: RenderEnv
): Promise<{ cx: number; cy: number; w: number; h: number }> {
  const cx = overlay.x * frame.width;
  const cy = overlay.y * frame.height;
  const kind = overlay.kind ?? "text";
  if (kind === "effect") return { cx, cy, w: 2, h: 2 };
  if (kind === "shape") {
    const s = overlay as ShapeOverlay;
    const m = shapeMetrics(s, frame);
    const lineLike = lineLikeShape(s.shape);
    return {
      cx,
      cy,
      w: m.w + m.strokeWidth * 2 + (lineLike ? m.thickness : 0),
      h: (lineLike ? Math.max(m.thickness, m.headHalf * 2) : m.h) + m.strokeWidth * 2,
    };
  }
  if (kind === "sticker") {
    const s = overlay as StickerOverlay;
    const w = Math.max(1, s.w * frame.width);
    if (s.lottie) {
      const handle = s.assetId ? await env.resolveLottie?.(s.assetId) : null;
      const aspect = handle && handle.width > 0 ? handle.width / handle.height : 1;
      return { cx, cy, w, h: w / aspect };
    }
    const img = s.assetId && env.resolveAsset ? await env.resolveAsset(s.assetId) : null;
    const aspect = img && img.width > 0 && img.height > 0 ? img.width / img.height : 1;
    return { cx, cy, w, h: w / aspect };
  }
  const o = overlay as TextOverlay;
  const fpx = o.size * frame.scale;
  const cssFont = textCssFont(o, fpx, env);
  await ensureFontLoaded(cssFont, o.text);
  const scratch = document.createElement("canvas");
  const ctx = scratch.getContext("2d")!;
  ctx.font = cssFont;
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${(o.letterSpacing ?? 0) * fpx}px`;
  const lines = o.text.split("\n");
  const maxW = Math.max(...lines.map((l) => ctx.measureText(l).width), 1);
  const lineH = fpx * (o.lineHeight ?? LINE_HEIGHT);
  let w = maxW;
  let h = lines.length * lineH;
  if (o.plate) {
    w += PLATE_PAD_X * fpx * 2;
    h += PLATE_PAD_Y * fpx * 2;
  }
  const strokePad = (o.stroke?.width ?? 0) * fpx * 2;
  const shadow = resolveShadow(o.shadow);
  const shadowPad = shadow ? (shadow.blur + Math.abs(shadow.offsetY)) * frame.scale : 0;
  // Ascenders/descenders overhang the em-box line grid a little.
  return { cx, cy, w: w + strokePad * 2 + shadowPad * 2, h: h + fpx * 0.3 + strokePad * 2 + shadowPad * 2 };
}

/** One window of an animated element, ready to be drawn under a per-frame
 * transform. `overlay` is neutral — rotation and opacity belong to the pose,
 * so a picture that baked them in would apply each twice — and a typewriter
 * window carries the characters revealed so far. */
export interface AnimatedLayer {
  overlay: Overlay;
  start: number; // timeline seconds
  end: number;
  /** The slots still in play for this window (a typed-out one has spent its
   * ramp, so that slot is gone). */
  anim: OverlayAnim;
}

/** Typewriter slices per second: one per output frame, matching the rate the
 * frame sequences sample at. */
const TYPE_SLICE_FPS = 30;

/**
 * Split an animated element into the windows a canvas renderer draws.
 *
 * Continuous transforms — slides, fades, loops, a keyframed pose — stay one
 * window whose picture is drawn under a per-frame transform. A typewriter
 * changes the pixels themselves, so its ramp becomes one window per revealed
 * slice. This is the canvas-side twin of `renderOverlayFrames`: same split,
 * one baked into pictures, the other handed to a compositor.
 */
export function planAnimatedLayers(o: Overlay, end: number): AnimatedLayer[] {
  const anim: OverlayAnim = o.anim ?? {};
  const dur = Math.max(0.1, o.end - o.start);
  const isTw = (slot: "in" | "out") =>
    anim[slot]?.style === "typewriter" && (o.kind ?? "text") === "text";
  const inS = anim.in ? Math.min(anim.in.seconds, dur) : 0;
  const outS = anim.out ? Math.min(anim.out.seconds, Math.max(0, dur - inS)) : 0;
  const out: AnimatedLayer[] = [];
  const push = (overlay: Overlay, from: number, to: number, animPart: OverlayAnim) => {
    const start = Math.max(o.start, from);
    const stop = Math.min(end, to);
    if (stop - start < 1e-3) return;
    out.push({
      overlay: { ...overlay, rotation: undefined, opacity: undefined } as Overlay,
      start,
      end: stop,
      anim: animPart,
    });
  };
  const typeSlices = (from: number, secs: number, reverse: boolean) => {
    const text = (o as TextOverlay).text;
    const n = Math.max(1, Math.min(text.length, Math.ceil(secs * TYPE_SLICE_FPS)));
    for (let i = 1; i <= n; i++) {
      const chars = Math.ceil((text.length * (reverse ? n - i + 1 : i)) / n);
      push(
        { ...o, text: text.slice(0, chars) } as Overlay,
        from + ((i - 1) / n) * secs,
        from + (i / n) * secs,
        { ...anim, [reverse ? "out" : "in"]: undefined }
      );
    }
  };

  if (inS > 1e-3) {
    if (isTw("in")) typeSlices(o.start, inS, false);
    else push(o, o.start, o.start + inS, anim);
  }
  push(o, o.start + inS, o.start + dur - outS, anim);
  if (outS > 1e-3) {
    if (isTw("out")) typeSlices(o.start + dur - outS, outS, true);
    else push(o, o.start + dur - outS, o.start + dur, anim);
  }
  return out;
}

/** One animated element as a region-cropped frame sequence: unique pictures
 * plus play entries (repeats reference the same picture, so a loop costs one
 * cycle of pixels however long the element runs). Entries cover the
 * element's [0, dur] exactly; the caller pads the timeline around it. */
export interface OverlayFrameSet {
  /** Region top-left in output px, and its size. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Unique region-sized pictures. */
  images: Blob[];
  /** Region-sized transparent filler for the ffconcat gaps. */
  blank: Blob;
  /** Play order: index into `images` + seconds on screen. */
  entries: { image: number; duration: number }[];
}

/**
 * Sample an animated element into frames at `fps`: the In and Out windows
 * frame by frame, the middle as one still (or one loop cycle, repeated by
 * reference). Samples the same evalOverlayAnim the live preview applies.
 */
export async function renderOverlayFrames(
  overlay: Overlay,
  width: number,
  height: number,
  fps: number,
  env: RenderEnv
): Promise<OverlayFrameSet> {
  const scale = Math.min(width, height) / 1080;
  const frame: PaintFrame = { width, height, scale };
  const anim = overlay.anim;
  const dur = Math.max(0.1, overlay.end - overlay.start);
  const inS = anim?.in ? Math.min(anim.in.seconds, dur) : 0;
  const outS = anim?.out ? Math.min(anim.out.seconds, Math.max(0, dur - inS)) : 0;
  // A Lottie sticker's pixels change every frame on their own; its play-through
  // acts as the middle segment's cycle even with no transform loop set.
  const sticker = (overlay.kind ?? "text") === "sticker" ? (overlay as StickerOverlay) : null;
  const lottieDur =
    sticker?.lottie && sticker.assetId
      ? ((await env.resolveLottie?.(sticker.assetId))?.duration ?? null)
      : null;

  // The crop region: the resting box, grown for travel, scale overshoot,
  // shadow spill, and — when anything rotates — the circumscribed square.
  const base = await measureElementBounds(overlay, frame, env);
  const styles: OverlayAnimStyle[] = [anim?.in?.style, anim?.out?.style].filter(
    (s): s is OverlayAnimStyle => !!s
  );
  const slides = styles.some((s) => s.startsWith("slide"));
  const travel =
    (slides ? SLIDE_TRAVEL : 0) * scale + (anim?.loop?.style === "float" ? FLOAT_TRAVEL * scale : 0);
  // A keyframed element carries its own travel and its own zoom: the region
  // spans every pose the track visits, at the largest scale it reaches.
  const keyed = hasOverlayKeys(overlay);
  const extent = poseExtent(overlay);
  const maxScale = 1.15 * extent.scale;
  const rotates =
    !!overlay.rotation ||
    anim?.loop?.style === "spin" ||
    anim?.loop?.style === "wiggle" ||
    (keyed && sortedKeys(overlay.kf!).some((k) => !!k.rotation));
  let halfW = (base.w * maxScale) / 2 + travel + 4;
  let halfH = (base.h * maxScale) / 2 + travel + 4;
  if (rotates) {
    const r = (Math.hypot(base.w, base.h) * maxScale) / 2 + travel + 4;
    halfW = r;
    halfH = r;
  }
  const x0 = Math.max(0, Math.floor(extent.x0 * width - halfW));
  const y0 = Math.max(0, Math.floor(extent.y0 * height - halfH));
  const x1 = Math.min(width, Math.ceil(extent.x1 * width + halfW));
  const y1 = Math.min(height, Math.ceil(extent.y1 * height + halfH));
  const rw = Math.max(2, x1 - x0);
  const rh = Math.max(2, y1 - y0);

  const canvas = document.createElement("canvas");
  canvas.width = rw;
  canvas.height = rh;
  const ctx = canvas.getContext("2d")!;
  const maskScratch = overlay.mask ? document.createElement("canvas") : null;

  const drawAt = async (tLocal: number): Promise<Blob> => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, rw, rh);
    const ev = evalOverlayFrame(overlay, tLocal);
    if (ev.opacity <= 0.001) return pngBlob(canvas); // fully transparent frame
    ctx.globalAlpha = ev.opacity;
    ctx.translate(-x0, -y0);
    // The pose places the element; the preset's travel rides on top of it.
    ctx.translate(ev.x * width + ev.dx * scale, ev.y * height + ev.dy * scale);
    ctx.rotate((ev.rotation * Math.PI) / 180);
    ctx.scale(ev.scale, ev.scale);
    // Back to the origin the painters draw around, so they stay unaware of
    // any of this.
    ctx.translate(-overlay.x * width, -overlay.y * height);
    let el: Overlay = { ...overlay, rotation: undefined, opacity: undefined };
    if (ev.textProgress !== undefined && (overlay.kind ?? "text") === "text") {
      const text = (overlay as TextOverlay).text;
      const chars = Math.max(0, Math.min(text.length, Math.ceil(ev.textProgress * text.length)));
      el = { ...el, text: text.slice(0, chars) } as Overlay;
      // Typing reveals characters; it must not also fade them.
      ctx.globalAlpha = poseAt(overlay, tLocal).opacity;
    }
    const maskTransform = ctx.getTransform();
    await paintElement(ctx, el, { ...frame, t: tLocal }, env);
    if (overlay.mask && maskScratch) {
      // Painted under the frame's element transform, so the mask rides the
      // pose; its own keys evaluate at this frame's time.
      applyMaskToCanvas(
        ctx,
        maskScratch,
        overlay.mask,
        tLocal,
        frame,
        { x: overlay.x, y: overlay.y },
        maskTransform
      );
    }
    return pngBlob(canvas);
  };

  const images: Blob[] = [];
  const entries: OverlayFrameSet["entries"] = [];
  const push = async (t: number, duration: number) => {
    images.push(await drawAt(t));
    entries.push({ image: images.length - 1, duration });
  };

  const step = 1 / fps;
  // A keyframed pose (or a keyframed mask) changes on its own schedule, so
  // there is no still middle and no cycle to repeat: sample the whole element
  // frame by frame.
  if (keyed || isMaskAnimated(overlay.mask)) {
    const n = Math.max(1, Math.round(dur * fps));
    for (let i = 0; i < n; i++) {
      await push(i * step, i === n - 1 ? dur - (n - 1) * step : step);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, rw, rh);
    return { x: x0, y: y0, w: rw, h: rh, images, blank: await pngBlob(canvas), entries };
  }
  // Head ramp, frame by frame; the last frame absorbs the rounding so the
  // segment lengths sum exactly.
  if (inS > 1e-3) {
    const n = Math.max(1, Math.round(inS * fps));
    for (let i = 0; i < n; i++) {
      await push(i * step, i === n - 1 ? inS - (n - 1) * step : step);
    }
  }
  const middle = dur - inS - outS;
  if (middle > 1e-3) {
    const period = loopPeriod(anim) ?? lottieDur;
    if (period) {
      // One cycle of pictures, repeated by reference to cover the middle.
      const n = Math.max(2, Math.min(Math.round(period * fps), 180));
      const cycleStep = period / n;
      const cycleStart = images.length;
      for (let j = 0; j < n; j++) images.push(await drawAt(inS + j * cycleStep));
      let remaining = middle;
      let j = 0;
      while (remaining > 1e-4) {
        const d = Math.min(cycleStep, remaining);
        entries.push({ image: cycleStart + (j % n), duration: d });
        remaining -= d;
        j++;
      }
    } else {
      await push(inS + middle / 2, middle);
    }
  }
  if (outS > 1e-3) {
    const from = dur - outS;
    const n = Math.max(1, Math.round(outS * fps));
    for (let i = 0; i < n; i++) {
      await push(from + i * step, i === n - 1 ? outS - (n - 1) * step : step);
    }
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, rw, rh);
  const blank = await pngBlob(canvas);
  return { x: x0, y: y0, w: rw, h: rh, images, blank, entries };
}
