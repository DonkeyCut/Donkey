"use client";

/**
 * The text-behind-speaker pass, shared by the live preview and the in-tab
 * export: with the video layers already on the canvas, snapshot them, draw
 * the behind-tagged title rasters, then segment the snapshot and draw the
 * person back on top. When no person registers the text simply stays on top —
 * the effect degrades to a normal front title instead of hiding words.
 */

import { evalOverlayFrame } from "@donkeycut/effects-kit";
import { personSegmenter, segmentSubjectAlpha } from "./cutout";
import { renderElementPng } from "./textRender";
import { isTextOverlay, type MediaAsset, type Overlay, type TextOverlay } from "./types";

type Segmenter = import("@mediapipe/tasks-vision").ImageSegmenter;

/** Segmentation input width — small on purpose; this runs per frame. */
const SEG_WIDTH = 256;

/** The behind-tagged titles live at `t`. */
export function behindOverlaysAt(overlays: Overlay[], t: number): TextOverlay[] {
  return overlays.filter(
    (o): o is TextOverlay =>
      isTextOverlay(o) &&
      !!o.behindSubject &&
      !o.hidden &&
      !!o.text.trim() &&
      t >= o.start &&
      t <= o.end
  );
}

/** Whether any element in the document wants the behind pass at all. */
export function hasBehindOverlays(overlays: Overlay[]): boolean {
  return overlays.some((o) => isTextOverlay(o) && !!o.behindSubject && !o.hidden);
}

export class BehindCompositor {
  private segmenter: Segmenter | null = null;
  private segKicked = false;
  private rasters = new WeakMap<TextOverlay, ImageBitmap>();
  private pending = new WeakSet<TextOverlay>();
  private person: HTMLCanvasElement | null = null;
  private small: HTMLCanvasElement | null = null;
  private mask: { at: number; alpha: HTMLCanvasElement | null } = { at: -1e9, alpha: null };

  /** Kick the (shared) segmenter load; safe to call every frame. */
  private ensureSegmenter() {
    if (this.segKicked) return;
    this.segKicked = true;
    void personSegmenter().then((s) => {
      this.segmenter = s;
    });
  }

  private rasterFor(
    o: TextOverlay,
    w: number,
    h: number,
    assets: MediaAsset[]
  ): ImageBitmap | null {
    const hit = this.rasters.get(o);
    if (hit) return hit;
    if (!this.pending.has(o)) {
      this.pending.add(o);
      // Neutral picture: position aside, the per-frame pose owns rotation and
      // opacity, so baking them here would apply each of them twice.
      void renderElementPng({ ...o, rotation: undefined, opacity: undefined }, w, h, assets)
        .then((png) => createImageBitmap(png))
        .then((bmp) => this.rasters.set(o, bmp))
        .catch(() => {});
    }
    return null;
  }

  /** Export path: everything resident before the first frame draws. */
  async prepare(overlays: Overlay[], w: number, h: number, assets: MediaAsset[]): Promise<void> {
    this.ensureSegmenter();
    await personSegmenter().then((s) => {
      this.segmenter = s;
    });
    const behind = overlays.filter(
      (o): o is TextOverlay => isTextOverlay(o) && !!o.behindSubject && !o.hidden
    );
    await Promise.all(
      behind.map(async (o) => {
        if (this.rasters.get(o)) return;
        try {
          const png = await renderElementPng(
            { ...o, rotation: undefined, opacity: undefined },
            w,
            h,
            assets
          );
          this.rasters.set(o, await createImageBitmap(png));
        } catch {
          // The overlay just draws in front when its raster is missing.
        }
      })
    );
  }

  /**
   * Run the pass on `canvas` (video layers already drawn). `minMaskInterval`
   * throttles segmentation for the live preview; pass 0 for exports.
   */
  draw(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    overlays: Overlay[],
    assets: MediaAsset[],
    t: number,
    opts: { minMaskInterval?: number } = {}
  ): void {
    const active = behindOverlaysAt(overlays, t);
    if (active.length === 0) return;
    this.ensureSegmenter();
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;

    // The person source: the video pixels before any text lands on them.
    if (!this.person || this.person.width !== W || this.person.height !== H) {
      this.person = document.createElement("canvas");
      this.person.width = W;
      this.person.height = H;
    }
    const pctx = this.person.getContext("2d")!;
    pctx.globalCompositeOperation = "source-over";
    pctx.clearRect(0, 0, W, H);
    pctx.drawImage(canvas, 0, 0);

    // The behind text, drawn straight onto the composite: a neutral raster
    // under the element's pose for this moment, exactly like the export's
    // stamped layers.
    const scale = Math.min(W, H) / 1080;
    for (const o of active) {
      const bmp = this.rasterFor(o, W, H, assets);
      if (!bmp) continue;
      const ev = evalOverlayFrame(o, Math.max(0, t - o.start));
      if (ev.opacity <= 0.001) continue;
      const cx = o.x * W;
      const cy = o.y * H;
      ctx.save();
      ctx.globalAlpha = ev.opacity;
      ctx.translate(ev.x * W + ev.dx * scale, ev.y * H + ev.dy * scale);
      ctx.rotate((ev.rotation * Math.PI) / 180);
      ctx.scale(ev.scale, ev.scale);
      ctx.translate(-cx, -cy);
      ctx.drawImage(bmp, 0, 0, W, H);
      ctx.restore();
    }

    // The person back on top. Segmentation is throttled: between refreshes
    // the previous mask rides the new frame (the subject moves little in
    // 1/15s, and a lagging mask beats a stuttering preview).
    if (!this.segmenter) return;
    const minInterval = opts.minMaskInterval ?? 1 / 15;
    if (!this.mask.alpha || Math.abs(t - this.mask.at) >= minInterval) {
      if (!this.small) this.small = document.createElement("canvas");
      const sw = SEG_WIDTH;
      const sh = Math.max(2, Math.round((SEG_WIDTH * H) / W));
      if (this.small.width !== sw || this.small.height !== sh) {
        this.small.width = sw;
        this.small.height = sh;
      }
      const sctx = this.small.getContext("2d", { willReadFrequently: true })!;
      sctx.drawImage(this.person, 0, 0, sw, sh);
      this.mask = { at: t, alpha: segmentSubjectAlpha(this.segmenter, this.small) };
    }
    if (!this.mask.alpha) return; // no person in shot: the text stays in front
    pctx.globalCompositeOperation = "destination-in";
    pctx.imageSmoothingEnabled = true;
    pctx.drawImage(this.mask.alpha, 0, 0, W, H);
    pctx.globalCompositeOperation = "source-over";
    ctx.drawImage(this.person, 0, 0);
  }
}
