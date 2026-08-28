"use client";

/**
 * The custom-removal brush session: what the brush has painted on the
 * current frame, held as a working mask the stage draws as a red overlay.
 * Every finished stroke also yields its seed record — the paint bitmaps the
 * doc stores, which the hosted tracker replays across the whole clip.
 */

import { matteLumaToAlpha } from "@donkeycut/effects-kit";
import { sampleClipSource } from "../previewCanvas";
import { createRasterCanvas, rasterCanvasToDataUrl, type RasterSurface } from "../raster";
import type { RemovalSeeds } from "../types";

/** Working-mask short side: enough for a crisp overlay, cheap to repaint on
 * every pointer move. */
const WORK_SHORT = 512;
/** Stored paint bitmaps stay small — they seed a tracker, never a render. */
const PAINT_SHORT = 256;

type Point = { x: number; y: number };

export class BrushSession {
  /** The current frame, drawn at working size. */
  private work: RasterSurface;
  /** White where the selection is. */
  private mask: RasterSurface;
  /** Scratch for compositing the mask into the red overlay tint. */
  private view: RasterSurface;
  private w = 2;
  private h = 2;

  private constructor() {
    this.work = createRasterCanvas(2, 2);
    this.mask = createRasterCanvas(2, 2);
    this.view = createRasterCanvas(2, 2);
  }

  static async open(): Promise<BrushSession> {
    return new BrushSession();
  }

  /** Pull the clip's current decoder frame into the working canvas. False
   * when no frame is ready yet. */
  refreshFrame(clipId: string): boolean {
    const src = sampleClipSource(clipId);
    if (!src) return false;
    const sw = Number((src as { width?: number }).width ?? 0) || 16;
    const sh = Number((src as { height?: number }).height ?? 0) || 9;
    const scale = WORK_SHORT / Math.max(1, Math.min(sw, sh));
    const w = Math.max(2, Math.round(sw * scale));
    const h = Math.max(2, Math.round(sh * scale));
    if (this.w !== w || this.h !== h) {
      this.w = w;
      this.h = h;
      this.work.width = w;
      this.work.height = h;
      const m = this.mask.getContext("2d") as CanvasRenderingContext2D | null;
      const keep = m && (this.mask.width > 2 ? this.mask : null);
      const prev = keep ? createRasterCanvas(this.mask.width, this.mask.height) : null;
      if (prev && keep) {
        (prev.getContext("2d") as CanvasRenderingContext2D).drawImage(keep as CanvasImageSource, 0, 0);
      }
      this.mask.width = w;
      this.mask.height = h;
      if (prev && m) m.drawImage(prev as CanvasImageSource, 0, 0, w, h);
    }
    const ctx = this.work.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) return false;
    ctx.drawImage(src, 0, 0, w, h);
    return true;
  }

  /** Paint one stroke into the mask. `radius` is a fraction of the frame's
   * short side. */
  paintStroke(points: Point[], radius: number, erase: boolean): void {
    const ctx = this.mask.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx || points.length === 0) return;
    const r = Math.max(1, radius * Math.min(this.w, this.h));
    ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
    ctx.strokeStyle = "#ffffff";
    ctx.fillStyle = "#ffffff";
    ctx.lineWidth = r * 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(points[0].x * this.w, points[0].y * this.h);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x * this.w, points[i].y * this.h);
    if (points.length === 1) {
      ctx.arc(points[0].x * this.w, points[0].y * this.h, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  /** The stroke's stored paint bitmap: the stroke alone, small grayscale PNG
   * (white marks) for the seed record. */
  async paintSeed(points: Point[], radius: number): Promise<string> {
    const scale = PAINT_SHORT / Math.max(1, Math.min(this.w, this.h));
    const w = Math.max(2, Math.round(this.w * scale));
    const h = Math.max(2, Math.round(this.h * scale));
    const c = createRasterCanvas(w, h);
    const ctx = c.getContext("2d") as CanvasRenderingContext2D;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, w, h);
    const r = Math.max(1, radius * Math.min(w, h));
    ctx.strokeStyle = "#ffffff";
    ctx.fillStyle = "#ffffff";
    ctx.lineWidth = r * 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(points[0].x * w, points[0].y * h);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x * w, points[i].y * h);
    if (points.length === 1) {
      ctx.arc(points[0].x * w, points[0].y * h, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.stroke();
    }
    return rasterCanvasToDataUrl(c, "image/png");
  }

  /** Rebuild the mask from the paint recorded on the current frame. `at` is
   * the frame's source second; a stroke recorded on another frame stays off
   * this overlay. */
  replaySeeds(
    seeds: RemovalSeeds | undefined,
    decode: (url: string) => Promise<CanvasImageSource | null>,
    at: number
  ): Promise<void> {
    this.reset();
    if (!seeds) return Promise.resolve();
    const paints = (seeds.paint ?? []).filter((p) => Math.abs(p.t - at) < 0.05);
    return (async () => {
      const ctx = this.mask.getContext("2d") as CanvasRenderingContext2D | null;
      if (!ctx) return;
      for (const p of paints) {
        for (const [url, erase] of [
          [p.add, false],
          [p.erase, true],
        ] as const) {
          if (!url) continue;
          const img = await decode(url);
          if (!img) continue;
          ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
          // The paint is white on black; its luma is the stroke, so cut the
          // black away first via a lightened draw onto a scratch.
          const s = createRasterCanvas(this.w, this.h);
          const sctx = s.getContext("2d") as CanvasRenderingContext2D;
          sctx.drawImage(img, 0, 0, this.w, this.h);
          const px = sctx.getImageData(0, 0, this.w, this.h);
          matteLumaToAlpha(px.data);
          sctx.putImageData(px, 0, 0);
          ctx.drawImage(s as CanvasImageSource, 0, 0);
        }
      }
      ctx.globalCompositeOperation = "source-over";
    })();
  }

  reset(): void {
    const ctx = this.mask.getContext("2d") as CanvasRenderingContext2D | null;
    ctx?.clearRect(0, 0, this.mask.width, this.mask.height);
  }

  /** Whether anything is selected right now. */
  hasSelection(): boolean {
    const ctx = this.mask.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) return false;
    const px = ctx.getImageData(0, 0, this.mask.width, this.mask.height).data;
    for (let i = 3; i < px.length; i += 64) if (px[i] > 32) return true;
    return false;
  }

  /** Paint the selection into a display context as the red overlay. */
  paintOverlay(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    if (this.view.width !== this.w || this.view.height !== this.h) {
      this.view.width = this.w;
      this.view.height = this.h;
    }
    const view = this.view;
    const vctx = view.getContext("2d") as CanvasRenderingContext2D;
    vctx.globalCompositeOperation = "source-over";
    vctx.clearRect(0, 0, this.w, this.h);
    vctx.drawImage(this.mask as CanvasImageSource, 0, 0);
    vctx.globalCompositeOperation = "source-in";
    vctx.fillStyle = "#ff2244";
    vctx.fillRect(0, 0, this.w, this.h);
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = 0.5;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(view as CanvasImageSource, 0, 0, w, h);
    ctx.globalAlpha = 1;
  }

  /** The selection mask (white, alpha-carrying) for the stage's red overlay. */
  overlay(): CanvasImageSource {
    return this.mask as CanvasImageSource;
  }

  /** The current frame at working size, for the loupe. */
  frame(): CanvasImageSource {
    return this.work as CanvasImageSource;
  }

  get width() {
    return this.w;
  }
  get height() {
    return this.h;
  }
}
