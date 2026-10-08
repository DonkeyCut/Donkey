/**
 * Drawing an element soft: its blur and its motion streak, and the darkening
 * a hit gives it.
 *
 * Both act on the element's posed picture as it lands on screen, so every
 * renderer does the same three steps: pose the element into a scratch surface
 * the size of the target, smear that along the streak, and lay the result on
 * the target through a Gaussian blur. The smear is the picture drawn a few
 * times along the streak with additive blending at 1/n strength each, which
 * sums to the exact average of the copies — the box filter a shutter makes.
 * Additive blending and `filter: blur()` mean the same thing on a browser
 * canvas and on the server canvas, so the preview, the tab export and the
 * headless renderers draw the same frame.
 *
 * Nothing extra runs for a sharp, still element: `begin` hands back the
 * target itself and `end` does nothing.
 */

import { streakTaps } from "./camera";
import { TILT_PERSPECTIVE } from "./keys";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Surface = HTMLCanvasElement | OffscreenCanvas;

/** What softens one element on one frame, in output px. */
export interface ElementLook {
  /** Gaussian blur radius (the CSS `blur()` length). */
  blur: number;
  /** The streak, end to end, centered on the frame's moment. */
  streakX: number;
  streakY: number;
  /** How many copies the streak is drawn from; 0 = no streak. */
  taps: number;
  /** What a hit leaves of the element's color, 0..1; 1 = untouched. */
  brightness: number;
  /** A 3D tilt, degrees (see OverlayKey.tiltX/tiltY), turned about (cx, cy)
   * in output px at `depth` px from the viewer; absent = flat. */
  tilt?: { x: number; y: number; cx: number; cy: number; depth: number };
}

/** A blur below this many output px is invisible and skipped. */
const BLUR_FLOOR = 0.1;

/** The look an evaluated frame asks for at `scale` output px per design px,
 * or null when the element draws sharp and at its own color. */
export function elementLook(
  ev: { blur?: number; streak?: { x: number; y: number }; brightness?: number; tiltX?: number; tiltY?: number },
  scale: number,
  /** The element's posed center on the target, output px; a tilt turns about
   * it. Absent = the element draws flat. */
  center?: { x: number; y: number }
): ElementLook | null {
  const blur = (ev.blur ?? 0) * scale;
  const taps = ev.streak ? streakTaps(Math.hypot(ev.streak.x, ev.streak.y)) : 0;
  const brightness = ev.brightness ?? 1;
  const tilted = !!center && !!(ev.tiltX || ev.tiltY);
  if (blur < BLUR_FLOOR && taps === 0 && !(brightness < 1) && !tilted) return null;
  return {
    blur: blur < BLUR_FLOOR ? 0 : blur,
    streakX: taps ? ev.streak!.x * scale : 0,
    streakY: taps ? ev.streak!.y * scale : 0,
    taps,
    brightness,
    ...(tilted
      ? {
          tilt: {
            x: ev.tiltX ?? 0,
            y: ev.tiltY ?? 0,
            cx: center!.x,
            cy: center!.y,
            depth: TILT_PERSPECTIVE * scale,
          },
        }
      : {}),
  };
}

/** How far, in output px, the affine a tile is drawn with may stray from
 * the true projection at the tile's far corner. */
const TILT_TILE_ERROR = 0.4;

/**
 * Draw `src` onto a cleared `ctx` turned in perspective the way CSS draws
 * perspective(depth) rotateX(x) rotateY(y) about (cx, cy): turned about the
 * vertical axis (the right edge away for a positive y), then about the
 * horizontal one (the top edge away for a positive x), then divided by the
 * depth each point sits at. The picture is cut into tiles small enough that
 * the affine carrying three of a tile's corners to where they project lands
 * the fourth within a fraction of a pixel.
 */
export function drawTilted(
  ctx: Ctx,
  src: Surface,
  x: number,
  y: number,
  cx: number,
  cy: number,
  depth: number
): void {
  const a = (x * Math.PI) / 180;
  const b = (y * Math.PI) / 180;
  const sa = Math.sin(a);
  const ca = Math.cos(a);
  const sb = Math.sin(b);
  const cb = Math.cos(b);

  // A source pixel's depth, and where it lands on the target.
  const zOf = (u: number, v: number) => (v - cy) * sa - (u - cx) * ca * sb;
  const land = (u: number, v: number): [number, number] => {
    const du = u - cx;
    const dv = v - cy;
    const f = depth / Math.max(1, depth - zOf(u, v));
    return [cx + du * cb * f, cy + (dv * ca + du * sa * sb) * f];
  };

  // Square tiles: across a tile of side T depth changes by about slope·T,
  // which scales its far corner by that over the depth, a miss of about
  // slope·T² / depth px. Sized to keep the miss under the bound, e.g. 1600
  // deep with x tipped 60° gives 27 px tiles.
  const slope = Math.max(Math.abs(ca * sb), Math.abs(sa), 1e-6);
  const side = Math.max(4, Math.sqrt((TILT_TILE_ERROR * depth) / slope));
  const tw = Math.min(src.width, side);
  const th = Math.min(src.height, side);

  ctx.save();
  for (let v = 0; v < src.height; v += th) {
    for (let u = 0; u < src.width; u += tw) {
      const w = Math.min(tw, src.width - u);
      const h = Math.min(th, src.height - v);

      // A tile turned past the viewer never shows.
      if (depth - zOf(u + w / 2, v + h / 2) <= 1) {
        continue;
      }

      // The affine that carries the tile's corner and its two edges onto
      // where they land.
      const [x0, y0] = land(u, v);
      const [x1, y1] = land(u + w, v);
      const [x2, y2] = land(u, v + h);
      const m = [(x1 - x0) / w, (y1 - y0) / w, (x2 - x0) / h, (y2 - y0) / h];
      ctx.setTransform(m[0], m[1], m[2], m[3], x0 - m[0] * u - m[2] * v, y0 - m[1] * u - m[3] * v);

      // Each tile reaches half a pixel into its neighbors, so antialiased
      // seams between them never show.
      const u0 = Math.max(0, u - 0.5);
      const v0 = Math.max(0, v - 0.5);
      const u1 = Math.min(src.width, u + w + 0.5);
      const v1 = Math.min(src.height, v + h + 0.5);
      ctx.drawImage(src, u0, v0, u1 - u0, v1 - v0, u0, v0, u1 - u0, v1 - v0);
    }
  }
  ctx.restore();
}

/**
 * Multiply every color already on a surface by `brightness` (0..1), leaving
 * alpha alone: black laid source-atop at 1 - brightness. The surface has to
 * hold the element by itself, or whatever sits under it darkens too.
 */
export function darkenCanvas(ctx: Ctx, width: number, height: number, brightness: number): void {
  if (!(brightness < 1)) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-atop";
  ctx.globalAlpha = Math.min(1, 1 - Math.max(0, brightness));
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

/** A context back to plain drawing: identity transform, full alpha,
 * source-over, no filter. */
function reset(c: Ctx): void {
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.globalCompositeOperation = "source-over";
  if ("filter" in c) c.filter = "none";
}

/**
 * Draw `src` along the streak onto a cleared `ctx`, with (x, y) the place it
 * would sit with no streak. The caller's transform applies, so a streak given
 * in an element's own space smears in that space. A streak has at least two
 * taps (`streakTaps`).
 */
export function drawStreak(
  ctx: Ctx,
  src: CanvasImageSource,
  x: number,
  y: number,
  look: Pick<ElementLook, "streakX" | "streakY" | "taps">
): void {
  const n = look.taps;
  const op = ctx.globalCompositeOperation;
  const alpha = ctx.globalAlpha;
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = alpha / n;
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1) - 0.5;
    ctx.drawImage(src, x + look.streakX * f, y + look.streakY * f);
  }
  ctx.globalCompositeOperation = op;
  ctx.globalAlpha = alpha;
}

/**
 * The scratch a renderer keeps for soft elements: two surfaces, made on first
 * use and reused frame after frame at the target's size.
 */
export class ElementFx {
  private picture: Surface | null = null;
  private smear: Surface | null = null;
  private look: ElementLook | null = null;

  constructor(private make: (w: number, h: number) => Surface) {}

  private fit(s: Surface | null, w: number, h: number): Surface {
    const width = Math.max(1, Math.round(w));
    const height = Math.max(1, Math.round(h));
    if (!s) return this.make(width, height);
    if (s.width !== width || s.height !== height) {
      s.width = width;
      s.height = height;
    }
    return s;
  }

  /** Where to paint the posed element: `ctx` itself when it draws sharp, or a
   * cleared scratch the size of the target, with an identity transform. */
  begin(ctx: Ctx, width: number, height: number, look: ElementLook | null): Ctx {
    this.look = look;
    if (!look) return ctx;
    this.picture = this.fit(this.picture, width, height);
    const c = this.picture.getContext("2d") as Ctx;
    reset(c);
    c.clearRect(0, 0, this.picture.width, this.picture.height);
    return c;
  }

  /** Lay the painted element onto `ctx` with its streak, darkening and blur. */
  end(ctx: Ctx): void {
    const look = this.look;
    this.look = null;
    if (!look || !this.picture) return;
    let src: Surface = this.picture;
    if (look.taps >= 2) {
      this.smear = this.fit(this.smear, src.width, src.height);
      const s = this.smear.getContext("2d") as Ctx;
      reset(s);
      s.clearRect(0, 0, this.smear.width, this.smear.height);
      drawStreak(s, src, 0, 0, look);
      src = this.smear;
    }
    // The scratch holds the element alone, so a hit darkens its pixels only.
    darkenCanvas(src.getContext("2d") as Ctx, src.width, src.height, look.brightness);
    // A tilt turns the finished picture in perspective, read from one
    // scratch and drawn onto the other.
    const tilt = look.tilt;
    if (tilt) {
      const dst = src === this.picture ? (this.smear = this.fit(this.smear, src.width, src.height)) : this.picture!;
      const dc = dst.getContext("2d") as Ctx;
      reset(dc);
      dc.clearRect(0, 0, dst.width, dst.height);
      drawTilted(dc, src, tilt.x, tilt.y, tilt.cx, tilt.cy, tilt.depth);
      src = dst;
    }
    ctx.save();
    reset(ctx);
    if (look.blur > 0 && "filter" in ctx) ctx.filter = `blur(${look.blur.toFixed(2)}px)`;
    ctx.drawImage(src, 0, 0);
    ctx.restore();
  }

  /** Bytes the scratch surfaces hold, for a host's memory report. */
  bytes(): number {
    let n = 0;
    for (const s of [this.picture, this.smear]) if (s) n += s.width * s.height * 4;
    return n;
  }

  /** Give the scratch memory back. */
  dispose(): void {
    for (const s of [this.picture, this.smear]) {
      if (!s) continue;
      s.width = 1;
      s.height = 1;
    }
    this.picture = null;
    this.smear = null;
  }
}
