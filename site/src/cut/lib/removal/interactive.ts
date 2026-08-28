"use client";

/**
 * The custom-removal selection session: what the brush has picked on the
 * current frame, held as a working mask the stage draws as a red overlay.
 * Quick strokes run the on-device tap-to-select segmenter for instant
 * feedback; manual strokes paint the mask directly. Every finished stroke
 * also yields its seed record — the point prompts and paint bitmaps the doc
 * stores, which the hosted tracker replays across the whole clip.
 */

import { matteLumaToAlpha } from "@donkeycut/effects-kit";
import { interactiveSegmenter, segmentTouchAlpha } from "../cutout";
import { sampleClipSource } from "../previewCanvas";
import { createRasterCanvas, rasterCanvasToDataUrl, type RasterSurface } from "../raster";
import type { WandScratch } from "./touchMask";
import type { RemovalSeeds } from "../types";

/** Working-mask short side: enough for a crisp overlay, cheap to re-segment
 * on every pointer move. */
const WORK_SHORT = 512;
/** Stored paint bitmaps stay small — they seed a tracker, never a render. */
const PAINT_SHORT = 256;

type Point = { x: number; y: number };

export class QuickSelectSession {
  /** The current frame, drawn at working size. */
  private work: RasterSurface;
  /** White where the selection is. */
  private mask: RasterSurface;
  /** The stroke in flight, previewed over (or out of) the mask until the
   * pointer lifts. */
  private tentative: RasterSurface;
  /** Scratch for compositing mask + tentative into the red overlay tint. */
  private view: RasterSurface;
  private tentativeErase = false;
  private hasTentative = false;
  private w = 2;
  private h = 2;
  private seg: Awaited<ReturnType<typeof interactiveSegmenter>> = null;
  /** The working frame's pixels and the wand's tone field, read once per
   * frame and shared across a stroke's per-move re-segmentations. */
  private frameRgba: Uint8ClampedArray | null = null;
  private wandScratch: WandScratch = {};

  private constructor() {
    this.work = createRasterCanvas(2, 2);
    this.mask = createRasterCanvas(2, 2);
    this.tentative = createRasterCanvas(2, 2);
    this.view = createRasterCanvas(2, 2);
  }

  /** Null when the tap-to-select model is unavailable — the manual brush and
   * erase still work through the returned session in that case. */
  static async open(): Promise<QuickSelectSession> {
    const s = new QuickSelectSession();
    s.seg = await interactiveSegmenter();
    return s;
  }

  get quickAvailable(): boolean {
    return !!this.seg;
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
      this.tentative.width = w;
      this.tentative.height = h;
      this.hasTentative = false;
    }
    const ctx = this.work.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) return false;
    ctx.drawImage(src, 0, 0, w, h);
    this.frameRgba = null;
    this.wandScratch = {};
    return true;
  }

  /** The working frame's pixels, read once per refreshed frame. */
  private rgbaOf(): Uint8ClampedArray | undefined {
    if (!this.frameRgba) {
      const ctx = this.work.getContext("2d") as CanvasRenderingContext2D | null;
      if (!ctx) return undefined;
      this.frameRgba = ctx.getImageData(0, 0, this.w, this.h).data;
    }
    return this.frameRgba;
  }

  /** Run tap-to-select over the stroke and fold the result into the mask.
   * `erase` subtracts the picked object. True when something registered. */
  quickStroke(points: Point[], erase: boolean): boolean {
    if (!this.seg || points.length === 0) return false;
    const alpha = segmentTouchAlpha(this.seg, this.work as HTMLCanvasElement, points, {
      rgba: this.rgbaOf(),
      scratch: this.wandScratch,
    });
    if (!alpha) return false;
    const ctx = this.mask.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) return false;
    ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(alpha, 0, 0, this.w, this.h);
    ctx.globalCompositeOperation = "source-over";
    return true;
  }

  /** Preview a quick stroke while the pointer is still down: the picked
   * object shows over (or carves out of) the mask, folded in only on
   * `commitTentative`. */
  quickPreview(points: Point[], erase: boolean): boolean {
    if (!this.seg || points.length === 0) return false;
    const alpha = segmentTouchAlpha(this.seg, this.work as HTMLCanvasElement, points, {
      rgba: this.rgbaOf(),
      scratch: this.wandScratch,
    });
    const ctx = this.tentative.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) return false;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!alpha) {
      this.hasTentative = false;
      return false;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(alpha, 0, 0, this.w, this.h);
    this.tentativeErase = erase;
    this.hasTentative = true;
    return true;
  }

  /** Fold the previewed stroke into the mask. */
  commitTentative(): void {
    if (!this.hasTentative) return;
    const ctx = this.mask.getContext("2d") as CanvasRenderingContext2D | null;
    if (ctx) {
      ctx.globalCompositeOperation = this.tentativeErase ? "destination-out" : "source-over";
      ctx.drawImage(this.tentative as CanvasImageSource, 0, 0);
      ctx.globalCompositeOperation = "source-over";
    }
    this.dropTentative();
  }

  dropTentative(): void {
    this.hasTentative = false;
    const ctx = this.tentative.getContext("2d") as CanvasRenderingContext2D | null;
    ctx?.clearRect(0, 0, this.w, this.h);
  }

  /** Paint one manual stroke into the mask. `radius` is a fraction of the
   * frame's short side. */
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

  /** Rebuild the mask from the seeds recorded on the current frame: prompts
   * re-segment, paint bitmaps replay over them. `at` is the frame's source
   * second; a stroke recorded on another frame stays off this overlay — the
   * segmenter would pick whatever sits under its points now, a different
   * object than the stroke selected. */
  replaySeeds(
    seeds: RemovalSeeds | undefined,
    decode: (url: string) => Promise<CanvasImageSource | null>,
    at: number
  ): Promise<void> {
    this.reset();
    if (!seeds) return Promise.resolve();
    const here = (t: number) => Math.abs(t - at) < 0.05;
    for (const p of seeds.prompts) {
      if (!here(p.t)) continue;
      const keeps = p.points.filter((pt) => pt.label === 1);
      const drops = p.points.filter((pt) => pt.label === 0);
      if (keeps.length) this.quickStroke(keeps, false);
      if (drops.length) this.quickStroke(drops, true);
    }
    const paints = (seeds.paint ?? []).filter((p) => here(p.t));
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

  /** Paint the selection (committed mask plus the stroke in flight) into a
   * display context as the red overlay. */
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
    if (this.hasTentative) {
      vctx.globalCompositeOperation = this.tentativeErase ? "destination-out" : "source-over";
      vctx.drawImage(this.tentative as CanvasImageSource, 0, 0);
      vctx.globalCompositeOperation = "source-over";
    }
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
