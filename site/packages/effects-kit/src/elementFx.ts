/**
 * Drawing an element soft: its blur and its motion streak.
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
}

/** A blur below this many output px is invisible and skipped. */
const BLUR_FLOOR = 0.1;

/** The look an evaluated frame asks for at `scale` output px per design px,
 * or null when the element draws sharp. */
export function elementLook(
  ev: { blur?: number; streak?: { x: number; y: number } },
  scale: number
): ElementLook | null {
  const blur = (ev.blur ?? 0) * scale;
  const taps = ev.streak ? streakTaps(Math.hypot(ev.streak.x, ev.streak.y)) : 0;
  if (blur < BLUR_FLOOR && taps === 0) return null;
  return {
    blur: blur < BLUR_FLOOR ? 0 : blur,
    streakX: taps ? ev.streak!.x * scale : 0,
    streakY: taps ? ev.streak!.y * scale : 0,
    taps,
  };
}

/**
 * Draw `src` along the streak onto a cleared `ctx`, with (x, y) the place it
 * would sit with no streak. The caller's transform applies, so a streak given
 * in an element's own space smears in that space.
 */
export function drawStreak(
  ctx: Ctx,
  src: CanvasImageSource,
  x: number,
  y: number,
  look: Pick<ElementLook, "streakX" | "streakY" | "taps">
): void {
  const n = look.taps;
  if (n < 2) {
    ctx.drawImage(src, x, y);
    return;
  }
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
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = "source-over";
    if ("filter" in c) c.filter = "none";
    c.clearRect(0, 0, this.picture.width, this.picture.height);
    return c;
  }

  /** Lay the painted element onto `ctx` with its streak and blur. */
  end(ctx: Ctx): void {
    const look = this.look;
    this.look = null;
    if (!look || !this.picture) return;
    let src: Surface = this.picture;
    if (look.taps >= 2) {
      this.smear = this.fit(this.smear, src.width, src.height);
      const s = this.smear.getContext("2d") as Ctx;
      s.setTransform(1, 0, 0, 1, 0, 0);
      s.globalAlpha = 1;
      s.globalCompositeOperation = "source-over";
      if ("filter" in s) s.filter = "none";
      s.clearRect(0, 0, this.smear.width, this.smear.height);
      drawStreak(s, src, 0, 0, look);
      src = this.smear;
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
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
