"use client";

/**
 * The subject-mask pass, shared by the live preview and the in-tab export.
 * The person matte drives two things: elements behind the speaker (with the
 * video layers already on the canvas, snapshot them, draw the behind-tagged
 * rasters, then segment the snapshot and draw the person back on top) and
 * elements or clips trimmed to the speaker. When no person registers the
 * behind effect degrades to the plain picture.
 */

import { evalOverlayFrame, glyphStateAt, hasGlyphMotion, maskComposite } from "@donkeycut/effects-kit";
import { personSegmenter, segmentSubjectAlpha } from "./cutout";
import { createRasterCanvas } from "./raster";
import { renderElementPng } from "./textRender";
import {
  behindSubjectOverlay,
  frontSubjectOverlay,
  isEffectOverlay,
  isTextOverlay,
  subjectMasked,
  type MediaAsset,
  type Overlay,
} from "./types";

type Segmenter = import("@mediapipe/tasks-vision").ImageSegmenter;

/** Segmentation input width — small on purpose; this runs per frame. */
const SEG_WIDTH = 256;

/** Whether the element has pixels the pass could draw at all. */
function drawable(o: Overlay): boolean {
  if (o.hidden || isEffectOverlay(o)) return false;
  if (isTextOverlay(o) && !o.text.trim()) return false;
  return true;
}

/** The behind-the-speaker elements live at `t` (any drawable kind). */
export function behindOverlaysAt(overlays: Overlay[], t: number): Overlay[] {
  return overlays.filter(
    (o) => behindSubjectOverlay(o) && drawable(o) && t >= o.start && t <= o.end
  );
}

/** Whether any element in the document sits behind the speaker. */
export function hasBehindOverlays(overlays: Overlay[]): boolean {
  return overlays.some((o) => behindSubjectOverlay(o) && drawable(o));
}

/** Whether anything in the document reads the person matte at all. */
export function hasSubjectOverlays(overlays: Overlay[]): boolean {
  return overlays.some((o) => subjectMasked(o) && drawable(o));
}

/** One computed matte frame: `alpha` holds the person's silhouette, and null
 * means the frame was segmented and no person registered — coverage is
 * empty, so a front subject layer shows nothing and a behind layer shows
 * whole. A compositor hands out null (no frame at all) only while the
 * segmenter is still loading. */
export interface SubjectMatte {
  alpha: HTMLCanvasElement | null;
}

/** The latest matte the running preview computed, published for the DOM
 * layer: front subject-masked elements turn it into a CSS mask-image. Only
 * the preview's compositor writes it — an in-tab export runs its own
 * compositor on its own clock and keeps out of the live editor's mattes. */
let published: { canvas: HTMLCanvasElement | null; at: number } | null = null;
export function subjectMatteSnapshot(): { canvas: HTMLCanvasElement | null; at: number } | null {
  return published;
}

/** Scratch off the raster seam. The pass types its surfaces as page canvases;
 * headless they are server canvases with the same 2D interface. */
const scratchCanvas = () => createRasterCanvas(1, 1) as HTMLCanvasElement;

export class SubjectMaskCompositor {
  /** `publishes` marks the live preview's instance, the one whose matte the
   * DOM layer reads. */
  constructor(private publishes = false) {}

  private segmenter: Segmenter | null = null;
  private segKicked = false;
  private rasters = new WeakMap<Overlay, ImageBitmap>();
  private pending = new WeakSet<Overlay>();
  private person: HTMLCanvasElement | null = null;
  private small: HTMLCanvasElement | null = null;
  private mask: { at: number; alpha: HTMLCanvasElement | null } = { at: -1e9, alpha: null };
  /** A second matte slot for mid-stack clip masks: it snapshots the canvas as
   * it stands when the masked clip draws (the layers beneath it), so a
   * masked layer never reads its own trimmed pixels back. */
  private clipMatte: { at: number; alpha: HTMLCanvasElement | null } = { at: -1e9, alpha: null };

  /** Kick the (shared) segmenter load; safe to call every frame. */
  private ensureSegmenter() {
    if (this.segKicked) return;
    this.segKicked = true;
    void personSegmenter().then((s) => {
      this.segmenter = s;
    });
  }

  private rasterFor(o: Overlay, w: number, h: number, assets: MediaAsset[]): ImageBitmap | null {
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
    const behind = overlays.filter((o) => behindSubjectOverlay(o) && drawable(o));
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

  /** Segment `source`'s current pixels into a person-alpha canvas, throttled
   * into `slot`. Returns null while the segmenter loads; a computed frame
   * with no person carries `alpha: null`. */
  private matteOf(
    source: HTMLCanvasElement | OffscreenCanvas,
    t: number,
    slot: { at: number; alpha: HTMLCanvasElement | null },
    minInterval: number
  ): SubjectMatte | null {
    this.ensureSegmenter();
    if (!this.segmenter) return null;
    if (slot.at > -1e8 && Math.abs(t - slot.at) < minInterval) return { alpha: slot.alpha };
    if (!this.small) this.small = scratchCanvas();
    const W = source.width;
    const H = source.height;
    const sw = SEG_WIDTH;
    const sh = Math.max(2, Math.round((SEG_WIDTH * H) / W));
    if (this.small.width !== sw || this.small.height !== sh) {
      this.small.width = sw;
      this.small.height = sh;
    }
    const sctx = this.small.getContext("2d", { willReadFrequently: true })!;
    sctx.clearRect(0, 0, sw, sh);
    sctx.drawImage(source, 0, 0, sw, sh);
    slot.at = t;
    slot.alpha = segmentSubjectAlpha(this.segmenter, this.small);
    return { alpha: slot.alpha };
  }

  /**
   * The matte a subject-masked video clip trims by, read mid-stack: the
   * canvas holds the layers beneath the clip at call time. Feed this as the
   * FrameCompositor's subject-matte provider.
   */
  clipMatteOf(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    t: number,
    opts: { minMaskInterval?: number } = {}
  ): SubjectMatte | null {
    return this.matteOf(canvas, t, this.clipMatte, opts.minMaskInterval ?? 1 / 15);
  }

  /** Refresh the full-composite matte for front subject-masked elements,
   * with the video layers already on the canvas; the preview instance also
   * publishes it for the DOM layer. */
  publishMatte(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    t: number,
    opts: { minMaskInterval?: number } = {}
  ): SubjectMatte | null {
    const res = this.matteOf(canvas, t, this.mask, opts.minMaskInterval ?? 1 / 15);
    if (this.publishes) {
      published = res ? { canvas: res.alpha, at: this.mask.at } : null;
    }
    return res;
  }

  /** Trim a stamped layer's pixels to the current matte (`invert` keeps the
   * outside), through `scratch`; feather blurs the matte edge. A computed
   * frame with no person clears a front layer (coverage is empty) and keeps
   * a behind layer whole; with no computed frame the layer stays whole. */
  applyMatte(
    target: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    scratch: HTMLCanvasElement,
    invert: boolean,
    featherPx: number
  ): void {
    const matte = this.mask.alpha;
    const W = target.canvas.width;
    const H = target.canvas.height;
    if (!matte) {
      if (this.mask.at > -1e8 && !invert) target.clearRect(0, 0, W, H);
      return;
    }
    if (scratch.width !== W) scratch.width = W;
    if (scratch.height !== H) scratch.height = H;
    const sctx = scratch.getContext("2d")!;
    sctx.clearRect(0, 0, W, H);
    if (featherPx > 0 && "filter" in sctx) sctx.filter = `blur(${featherPx / 2}px)`;
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(matte, 0, 0, W, H);
    sctx.filter = "none";
    maskComposite(target, scratch, invert);
  }

  /** One stamped layer trimmed to the current matte: `draw` puts the stamp's
   * pixels (posed and all) onto a per-instance surface, then the matte
   * multiplies in at identity — the matte stays anchored to the frame while
   * the element moves under it. The surfaces live and die with this pass. */
  private stampSurface: HTMLCanvasElement | null = null;
  private stampScratch: HTMLCanvasElement | null = null;
  mattedStamp(
    o: { mask?: { invert?: boolean; feather?: number } },
    w: number,
    h: number,
    draw: (ctx: CanvasRenderingContext2D) => void
  ): CanvasImageSource {
    if (!this.stampSurface || !this.stampScratch) {
      this.stampSurface = scratchCanvas();
      this.stampScratch = scratchCanvas();
    }
    if (this.stampSurface.width !== w) this.stampSurface.width = w;
    if (this.stampSurface.height !== h) this.stampSurface.height = h;
    const ctx = this.stampSurface.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    draw(ctx);
    ctx.restore();
    this.applyMatte(
      ctx,
      this.stampScratch,
      !!o.mask?.invert,
      (o.mask?.feather ?? 0) * (Math.min(w, h) / 1080)
    );
    return this.stampSurface;
  }

  /**
   * Run the behind pass on `canvas` (video layers already drawn): draw the
   * behind-tagged rasters, then the segmented person back over them. Also
   * refreshes and publishes the composite matte, so front subject elements
   * can read it even on frames with no behind element live. `minMaskInterval`
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
    const wantsMatte = overlays.some(
      (o) => frontSubjectOverlay(o) && drawable(o) && t >= o.start && t <= o.end
    );
    if (active.length === 0 && !wantsMatte) return;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;

    // The person source: the video pixels before any text lands on them.
    if (!this.person || this.person.width !== W || this.person.height !== H) {
      this.person = scratchCanvas();
      this.person.width = W;
      this.person.height = H;
    }
    const pctx = this.person.getContext("2d")!;
    pctx.globalCompositeOperation = "source-over";
    pctx.clearRect(0, 0, W, H);
    pctx.drawImage(canvas, 0, 0);

    // Segment (throttled) and publish before anything composites: between
    // refreshes the previous matte rides the new frame (the subject moves
    // little in 1/15s, and a lagging mask beats a stuttering preview).
    const alpha = this.publishMatte(canvas, t, opts)?.alpha ?? null;
    if (active.length === 0) return;

    // The behind elements, drawn straight onto the composite: a neutral
    // raster under the element's pose for this moment, exactly like the
    // export's stamped layers.
    const scale = Math.min(W, H) / 1080;
    for (const o of active) {
      const bmp = this.rasterFor(o, W, H, assets);
      if (!bmp) continue;
      const ev = evalOverlayFrame(o, Math.max(0, t - o.start));
      // One cached picture per element here, so a per-glyph ramp or loop runs
      // its motion over the whole box as a single letter would.
      const g = hasGlyphMotion(ev) ? glyphStateAt(ev, 0, 1) : null;
      const alphaOf = ev.opacity * (g?.alpha ?? 1);
      if (alphaOf <= 0.001) continue;
      const cx = o.x * W;
      const cy = o.y * H;
      ctx.save();
      ctx.globalAlpha = alphaOf;
      ctx.translate(
        ev.x * W + (ev.dx + (g?.dx ?? 0)) * scale,
        ev.y * H + (ev.dy + (g?.dy ?? 0)) * scale
      );
      ctx.rotate(((ev.rotation + (g?.rotate ?? 0)) * Math.PI) / 180);
      ctx.scale(ev.scale * (g?.sx ?? 1), ev.scale * (g?.sy ?? 1));
      ctx.translate(-cx, -cy);
      ctx.drawImage(bmp, 0, 0, W, H);
      ctx.restore();
    }

    // The person back on top, its edge softened by the widest feather any
    // live behind element asks for.
    if (!alpha) return; // no person in shot: the elements stay in front
    const feather = Math.max(0, ...active.map((o) => (o.mask?.feather ?? 0) * scale));
    pctx.globalCompositeOperation = "destination-in";
    pctx.imageSmoothingEnabled = true;
    if (feather > 0 && "filter" in pctx) pctx.filter = `blur(${feather / 2}px)`;
    pctx.drawImage(alpha, 0, 0, W, H);
    pctx.filter = "none";
    pctx.globalCompositeOperation = "source-over";
    ctx.drawImage(this.person, 0, 0);
  }
}
