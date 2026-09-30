"use client";

/**
 * Painting one frame of the cut.
 *
 * This is the whole picture side of Cut in one place: how a clip's grade and
 * look become pixels, how a transition's geometry joins two clips, how a
 * region, a pan, a zoom, and a fade land on the frame. It knows nothing about
 * where the pixels came from — a caller hands it a `Frame` and it draws.
 *
 * That indifference is the point. The live preview feeds it video elements it
 * is steering in real time; an export feeds it decoded frames it pulled at an
 * exact timestamp. Both draw through this same code, so what the editor shows
 * and what the file contains cannot drift apart by one being taught something
 * the other wasn't.
 *
 * Time is a parameter rather than a reading of the clock, which is what makes
 * an export deterministic: film grain at 4.5 seconds is the same grain whether
 * it was reached by playing there or by rendering the 135th frame.
 */

import { applyDetail, applyLutToImageData, applyMaskToCanvas, detailActive, grainTile, hexToHlgHex, lookCssFilter, lookPost, maskComposite, paintStrokeInk, removalActive, type ClipColorRecipe, type OutputSpace } from "@donkeycut/effects-kit";
import { applyDetailGpu } from "./detailGpu";
import { applyLutGpu } from "./gradeGpu";
import { clipRecipe, peekClipLut, requestClipLut, type ClipLut, type RecipeSource } from "./lutBuild";
import { createRasterCanvas } from "./raster";
import { clipCovers, clipPosed, clipPoseAt, clipZoom, contentRect, DEFAULT_BACKGROUND, isFullRect, rectOf, shadowInk } from "./types";
import type { ClipShadow, FrameRect, TransitionStyle, VideoClip } from "./types";

/** A clip's picture at some instant, or the reasons there isn't one.
 *
 * `missing` and `pending` differ in what they do to the frame: a clip with
 * nothing to draw yields to whatever should be behind it, while a clip whose
 * decoder just hasn't caught up keeps the last frame on screen. Painting black
 * for the second one is what strobing looks like while skimming.
 */
export type Frame =
  | { kind: "missing" }
  | { kind: "pending" }
  | {
      kind: "ready";
      image: CanvasImageSource;
      width: number;
      height: number;
      /** What these pixels' code values mean, from the reader that decoded
       * them. A frame held across a move to another file keeps its own;
       * absent, the clip's `sourceProvider` answers. */
      source?: RecipeSource;
    };

export const MISSING_FRAME: Frame = { kind: "missing" };
export const PENDING_FRAME: Frame = { kind: "pending" };

/** Frame motion a transition or animation puts on a layer, in canvas pixels. */
export interface LayerFx {
  dx?: number;
  dy?: number;
}

/** The two clips a transition joins, each with its ramps already resolved. */
export interface CrossJoin {
  masterFrame: Frame;
  masterClip: VideoClip;
  masterAlpha: number;
  masterZoom: number;
  masterFx: { dx: number; dy: number };
  incFrame: Frame;
  incClip: VideoClip | undefined;
  incAlpha: number;
  incZoom: number;
}

/** Canvas kinds the compositor can draw onto and allocate beside. */
type Surface = HTMLCanvasElement | OffscreenCanvas;
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** The grain tile advances on this cadence, in seconds per step. */
const GRAIN_STEP = 0.08;

/** The source every clip renders as when nothing says otherwise: Rec.709
 * display values, which need no conversion. */
const REC709_SOURCE: RecipeSource = { profile: "rec709" };

/** How many clips a compositor remembers the last drawn LUT for. */
const LAST_LUT_MAX = 64;

export class FrameCompositor {
  /** Scratch buffers, kept for the compositor's life: the grade pass, the
   * look's self-copy passes, and the vignette gradient. Allocating these per
   * frame is the difference between a preview that holds 60fps and one that
   * fights the garbage collector. */
  private gradeCanvas: Surface | null = null;
  private gradeLutScratch: Surface | null = null;
  private lookScratch: Surface | null = null;
  private vignetteCanvas: Surface | null = null;
  /** The masked/keyframed-layer pass: the layer draws into `layerScratch`,
   * its mask's coverage paints into `maskScratch`, a keyframed pose blits
   * through `poseScratch`, and the result composites back onto the frame. */
  private layerScratch: Surface | null = null;
  private maskScratch: Surface | null = null;
  private poseScratch: Surface | null = null;
  /** Where a shadow is cast before the picture goes down over it. */
  private shadowScratch: Surface | null = null;
  /** The removal pass: the keyed picture builds in `removalScratch`, its
   * silhouette in `removalSil`, the stroke's ink in `removalInk`, and an AI
   * matte lands in `removalMatte` on its way to the alpha multiply. */
  private removalScratch: Surface | null = null;
  private removalMatte: Surface | null = null;
  private removalSil: Surface | null = null;
  private removalInk: Surface | null = null;
  /** The piece renderer's look bake: the post passes run over a copy in
   * `removalLookA`, then land back inside the layer's own coverage through
   * `removalLookB`. */
  private removalLookA: Surface | null = null;
  private removalLookB: Surface | null = null;
  /** The pixel pass of the grade's spatial controls, when the GPU cannot
   * run it: a scratch the CPU reads and writes. */
  private detailScratch: Surface | null = null;

  /** What a clip's code values mean — its source profile, and whatever the
   * decode route adds — so the compositor can build the clip's color recipe.
   * Absent, every clip is Rec.709. */
  sourceProvider: ((clip: VideoClip) => RecipeSource) | null = null;

  /** The project's delivery space, which the recipe bakes toward. */
  output: OutputSpace = "sdr";

  /**
   * How a LUT that is not in hand is handled. `live` (the preview) never
   * waits: the build goes off the thread and the clip draws through the last
   * LUT it had, or plain, until it lands and `wake` repaints. `exact` (an
   * export, a baked layer) builds on this thread, so every frame is drawn
   * through its own LUT.
   */
  colorMode: "live" | "exact" = "live";

  /** Repaint request, fired when a LUT built off the thread lands. */
  wake: (() => void) | null = null;

  /** Per clip, the key of the LUT it last drew through: what stands in while
   * a newer one builds. Bounded; the LUTs themselves live in the cache. */
  private lastLut = new Map<string, string>();

  /** Where a subject-masked clip's person matte comes from: the host hands a
   * reader over the canvas as it stands (the layers beneath the clip), so
   * the matte never includes the masked clip's own pixels. A computed frame
   * with `alpha: null` means no person registered — empty coverage. Provider
   * absent, or a null frame = subject masks draw the plain picture (no
   * segmenter, or the matte pass that must not recurse). */
  subjectMatteProvider:
    | ((at: number) => { alpha: CanvasImageSource | null } | null)
    | null = null;

  /** Where a removal clip's baked AI matte comes from: an alpha image
   * (subject opaque, backdrop transparent — the host converts a decoded
   * luma frame) covering the clip's source frame at `at` timeline seconds.
   * Null = no matte yet; the picture draws plain until the bake lands. */
  removalMatteProvider: ((clip: VideoClip, at: number) => CanvasImageSource | null) | null = null;

  /** Resolves a backdrop fill's image asset to a drawable picture. */
  backdropImageProvider: ((assetId: string) => CanvasImageSource | null) | null = null;

  /** A clip id whose removal is bypassed this frame — the panel's eye toggle
   * showing the original picture. */
  removalBypass: string | null = null;

  /**
   * The frame's own color, behind everything drawn into it. The project owns
   * it, so the caller writes it before each frame; black keeps a compositor
   * nobody told rendering the way it always did.
   */
  background = DEFAULT_BACKGROUND;

  constructor(private canvas: Surface) {}

  /** Point the compositor at a different surface, keeping the scratch buffers. */
  setCanvas(canvas: Surface) {
    this.canvas = canvas;
  }

  get width() {
    return this.canvas.width;
  }

  get height() {
    return this.canvas.height;
  }

  private ctx(): Ctx | null {
    return this.canvas.getContext("2d") as Ctx | null;
  }

  /** A scratch surface of exactly `w`×`h`, reused across frames. Returns
   * whether it had to be resized — which also cleared it, since setting a
   * canvas dimension wipes its contents. */
  private scratch(
    field:
      | "gradeCanvas"
      | "gradeLutScratch"
      | "lookScratch"
      | "vignetteCanvas"
      | "layerScratch"
      | "maskScratch"
      | "poseScratch"
      | "shadowScratch"
      | "removalScratch"
      | "removalMatte"
      | "removalSil"
      | "removalInk"
      | "removalLookA"
      | "removalLookB"
      | "detailScratch",
    w: number,
    h: number
  ): { surface: Surface; resized: boolean } {
    let surface = this[field];
    if (!surface) {
      surface = createRasterCanvas(w, h);
      this[field] = surface;
    }
    // Match both dimensions — a transition alternates two differently-sized
    // sources through one scratch every frame, and a stale dimension leaves the
    // previous clip's pixels in the draw.
    const resized = surface.width !== w || surface.height !== h;
    if (surface.width !== w) surface.width = w;
    if (surface.height !== h) surface.height = h;
    return { surface, resized };
  }

  /** The frame color as the composite holds it: as is in SDR, and mapped
   * like every other sRGB graphic when the composite is HLG. One conversion
   * per color, held for the frames that follow. */
  private backgroundFill: { hex: string; output: OutputSpace; fill: string } | null = null;

  private backgroundFor(): string {
    if (this.output === "sdr") return this.background;
    const held = this.backgroundFill;
    if (held && held.hex === this.background && held.output === this.output) return held.fill;
    const fill = hexToHlgHex(this.background);
    this.backgroundFill = { hex: this.background, output: this.output, fill };
    return fill;
  }

  clear() {
    const ctx = this.ctx();
    if (!ctx) return;
    ctx.fillStyle = this.backgroundFor();
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Paint an `amount` (0..1) color veil (`rgb` = "r,g,b") — over the whole
   * frame, or clipped to `rect` for a per-clip fade. Shared by the fade
   * animations, the dip transitions, and the whole-video project fade so they
   * can never drift apart.
   */
  fillVeil(rgb: string, amount: number, rect?: FrameRect) {
    if (amount <= 0) return;
    const ctx = this.ctx();
    if (!ctx) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.fillStyle = `rgba(${rgb},${Math.min(1, amount).toFixed(3)})`;
    if (rect) ctx.fillRect(rect.x * W, rect.y * H, rect.w * W, rect.h * H);
    else ctx.fillRect(0, 0, W, H);
  }

  fillBlackVeil(amount: number, rect?: FrameRect) {
    this.fillVeil("0,0,0", amount, rect);
  }

  /** The recipe a clip renders through: its source, its grade, the output.
   * `frameSource` is the drawn frame's own, when its reader named one. */
  recipeFor(clip: VideoClip | undefined, frameSource?: RecipeSource): ClipColorRecipe {
    const source = frameSource ?? (clip && this.sourceProvider?.(clip)) ?? REC709_SOURCE;
    return clipRecipe(source, clip?.grade, this.output, this.colorMode === "live");
  }

  /**
   * The LUT a clip draws through this frame: its own when it is in hand,
   * the last one it drew through while a newer build is out, and none for
   * an identity recipe or a clip whose first LUT has not landed yet.
   */
  private lutFor(clip: VideoClip | undefined, recipe: ClipColorRecipe): ClipLut | null {
    const got = requestClipLut(recipe, {
      exact: this.colorMode === "exact",
      wake: this.wake ?? undefined,
    });
    if (got === null) {
      if (clip) this.lastLut.delete(clip.id);
      return null;
    }
    if (got) {
      if (clip && this.lastLut.get(clip.id) !== got.key) {
        this.lastLut.delete(clip.id);
        this.lastLut.set(clip.id, got.key);
        if (this.lastLut.size > LAST_LUT_MAX) {
          const oldest = this.lastLut.keys().next().value;
          if (oldest !== undefined) this.lastLut.delete(oldest);
        }
      }
      return got;
    }
    const last = clip && this.lastLut.get(clip.id);
    return last ? (peekClipLut(last) ?? null) : null;
  }

  /**
   * The clip's picture with its color and look applied, or the raw image
   * when there is nothing to apply. The color is one LUT per clip — source
   * conversion, library LUT and grade baked together — applied on the GPU
   * (the CPU where there is none), then the grade's sharpen and clarity as a
   * spatial pass, then the look's color pass as a canvas filter, in the order
   * the export's chain runs. Source alpha rides through every pass, so
   * transparent stills keep their transparency. The look's post passes
   * (vignette, grain, glow…) draw over the composited layer instead.
   */
  private gradedSource(
    frame: Extract<Frame, { kind: "ready" }>,
    clip: VideoClip | undefined
  ): CanvasImageSource {
    const recipe = this.recipeFor(clip, frame.source);
    const compiled = this.lutFor(clip, recipe);
    const detail = detailActive(clip?.grade) ? clip!.grade! : null;
    const lookCss = lookCssFilter(clip?.look, clip?.lookAmount);
    if (!compiled && !detail && !lookCss) return frame.image;
    const w = frame.width;
    const h = frame.height;
    let picture: CanvasImageSource = frame.image;
    if (compiled) {
      const gpu = applyLutGpu(picture, w, h, compiled.lut, compiled.key);
      if (gpu) {
        picture = gpu as CanvasImageSource;
      } else {
        const { surface: pixels } = this.scratch("gradeLutScratch", w, h);
        const pctx = pixels.getContext("2d") as Ctx | null;
        if (!pctx) return frame.image;
        pctx.clearRect(0, 0, w, h);
        pctx.drawImage(picture, 0, 0, w, h);
        const img = pctx.getImageData(0, 0, w, h);
        applyLutToImageData(img.data, compiled.lut);
        pctx.putImageData(img, 0, 0);
        picture = pixels as CanvasImageSource;
      }
    }
    if (detail) {
      const gpu = applyDetailGpu(picture, w, h, detail);
      if (gpu) {
        picture = gpu as CanvasImageSource;
      } else {
        const { surface: pixels } = this.scratch("detailScratch", w, h);
        const pctx = pixels.getContext("2d") as Ctx | null;
        if (!pctx) return picture;
        pctx.clearRect(0, 0, w, h);
        pctx.drawImage(picture, 0, 0, w, h);
        const img = pctx.getImageData(0, 0, w, h);
        applyDetail(img.data, w, h, detail);
        pctx.putImageData(img, 0, 0);
        picture = pixels as CanvasImageSource;
      }
    }
    if (!lookCss) return picture;
    const { surface: scratch } = this.scratch("gradeCanvas", w, h);
    const ctx = scratch.getContext("2d") as Ctx | null;
    // A context with no filter support draws the color without the look.
    if (!ctx || !("filter" in ctx)) return picture;
    ctx.clearRect(0, 0, w, h);
    ctx.filter = lookCss;
    ctx.drawImage(picture, 0, 0, w, h);
    ctx.filter = "none";
    return scratch;
  }

  /**
   * The clip's graded picture with its background removal applied: the baked
   * AI matte the host provides multiplies an alpha into the frame, the
   * stroke's ink goes down behind the
   * silhouette, and the backdrop fills in behind everything. Runs in the
   * clip's source pixel space, before the fit/fill draw, so the keyed layer
   * rides zoom, pan, masks, poses and transitions like any other picture.
   */
  /** The keyed layer alone, in source pixel space — what the ffmpeg export's
   * piece renderer encodes so the engine composites the very pixels the
   * preview draws. `bakeLookPost` folds the look's post passes (grain,
   * vignette, glow, washes) into the layer for the overlay pieces, where the
   * engine applies no look to an alpha layer: the passes run over a copy and
   * land back inside the layer's own coverage, so the keyed-out hole stays
   * transparent. */
  removedLayer(
    frame: Extract<Frame, { kind: "ready" }>,
    clip: VideoClip | undefined,
    at: number,
    opts: { bakeLookPost?: boolean } = {}
  ): CanvasImageSource {
    const out = this.removedSource(frame, clip, at);
    if (!opts.bakeLookPost || !lookPost(clip?.look, clip?.lookAmount)) return out;
    const w = frame.width;
    const h = frame.height;
    const { surface: processed } = this.scratch("removalLookA", w, h);
    const pctx = processed.getContext("2d") as Ctx | null;
    const { surface: baked } = this.scratch("removalLookB", w, h);
    const bctx = baked.getContext("2d") as Ctx | null;
    if (!pctx || !bctx) return out;
    for (const c of [pctx, bctx]) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = 1;
      c.globalCompositeOperation = "source-over";
      c.clearRect(0, 0, w, h);
      c.drawImage(out, 0, 0, w, h);
    }
    this.applyLookPost(clip, 0, 0, w, h, 1, at, { canvas: processed, ctx: pctx });
    bctx.globalCompositeOperation = "source-atop";
    bctx.drawImage(processed, 0, 0, w, h);
    bctx.globalCompositeOperation = "source-over";
    return baked as CanvasImageSource;
  }

  private removedSource(
    frame: Extract<Frame, { kind: "ready" }>,
    clip: VideoClip | undefined,
    at: number
  ): CanvasImageSource {
    const base = this.gradedSource(frame, clip);
    const r = clip?.removal;
    if (!r || !removalActive(r) || (clip && this.removalBypass === clip.id)) return base;
    const w = frame.width;
    const h = frame.height;
    // The matte answers before any scratch is staged: while the bake is still
    // running the picture stays plain — the stroke and backdrop wait with it —
    // and a full-frame clear and composite per tick would be pure waste.
    const matte = clip ? (this.removalMatteProvider?.(clip, at) ?? null) : null;
    if (!matte) return base;
    const { surface } = this.scratch("removalScratch", w, h);
    const ctx = surface.getContext("2d") as Ctx | null;
    if (!ctx) return base;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, w, h);

    // 1. The key: alpha into the picture. `invert` flips the direction — the
    // selection is removed and the rest of the picture stays.
    const inv = !!r.invert;
    ctx.drawImage(base, 0, 0, w, h);
    const { surface: cover } = this.scratch("removalMatte", w, h);
    const cctx = cover.getContext("2d") as Ctx | null;
    if (cctx) {
      cctx.setTransform(1, 0, 0, 1, 0, 0);
      cctx.clearRect(0, 0, w, h);
      cctx.imageSmoothingEnabled = true;
      cctx.drawImage(matte, 0, 0, w, h);
      maskComposite(ctx, cover as CanvasImageSource, inv);
    }

    const tLocal = Math.max(0, at - (clip?.start ?? 0));
    // Design px at the source frame's own short side: ink painted here is
    // scaled with the picture into its box, so the stroke holds its design
    // size wherever the clip lands.
    const ds = Math.min(w, h) / 1080;

    // 2. Stroke ink around the selection's silhouette, behind the picture.
    // The ink always traces the selection — inverted, that is the hole the
    // removal cut, whose boundary is the same curve, and the ink paints
    // inset so it rims the hole where it shows through.
    if (r.stroke) {
      const { surface: sil } = this.scratch("removalSil", w, h);
      const sctx = sil.getContext("2d") as Ctx | null;
      const { surface: ink } = this.scratch("removalInk", w, h);
      const ictx = ink.getContext("2d") as Ctx | null;
      if (sctx && ictx) {
        sctx.setTransform(1, 0, 0, 1, 0, 0);
        sctx.globalCompositeOperation = "source-over";
        sctx.clearRect(0, 0, w, h);
        if (!inv) {
          sctx.drawImage(surface, 0, 0);
        } else {
          sctx.drawImage(cover as CanvasImageSource, 0, 0);
        }
        sctx.globalCompositeOperation = "source-in";
        sctx.fillStyle = "#ffffff";
        sctx.fillRect(0, 0, w, h);
        sctx.globalCompositeOperation = "source-over";
        ictx.setTransform(1, 0, 0, 1, 0, 0);
        ictx.globalCompositeOperation = "source-over";
        ictx.clearRect(0, 0, w, h);
        paintStrokeInk(ictx, sil as CanvasImageSource, w, h, r.stroke, tLocal, ds, inv);
        // Color the white ink, then lay it under the picture.
        ictx.globalCompositeOperation = "source-in";
        ictx.fillStyle = r.stroke.color;
        ictx.fillRect(0, 0, w, h);
        ictx.globalCompositeOperation = "source-over";
        ctx.globalCompositeOperation = "destination-over";
        ctx.drawImage(ink, 0, 0);
        ctx.globalCompositeOperation = "source-over";
      }
    }

    // 3. Backdrop behind it all, covering the source frame.
    const bd = r.backdrop;
    if (bd && bd.kind !== "none") {
      ctx.globalCompositeOperation = "destination-over";
      if (bd.kind === "color" && bd.color) {
        ctx.fillStyle = bd.color;
        ctx.fillRect(0, 0, w, h);
      } else if (bd.kind === "image" && bd.assetId) {
        const img = this.backdropImageProvider?.(bd.assetId) ?? null;
        const iw = img ? Number((img as { width?: number }).width ?? 0) : 0;
        const ih = img ? Number((img as { height?: number }).height ?? 0) : 0;
        if (img && iw > 0 && ih > 0) {
          const s = Math.max(w / iw, h / ih);
          ctx.drawImage(img, (w - iw * s) / 2, (h - ih * s) / 2, iw * s, ih * s);
        }
      }
      ctx.globalCompositeOperation = "source-over";
    }
    return surface;
  }

  /**
   * Draw a look's post passes over one composited layer's footprint (canvas
   * pixels): vignette, animated grain, self-copy glow, color washes, chroma
   * ghosts. `alpha` follows the layer so a dissolving clip's grain dissolves
   * with it, and `at` drives the grain so the same second of the cut always
   * grains the same way. Every buffer here is cached — no per-frame allocation
   * or pixel reads.
   */
  private applyLookPost(
    clip: VideoClip | undefined,
    rx: number,
    ry: number,
    rw: number,
    rh: number,
    alpha: number,
    at: number,
    // A different surface to paint over — the piece renderer bakes the post
    // passes into the keyed layer itself. Default: the frame canvas.
    target?: { canvas: Surface; ctx: Ctx }
  ) {
    const post = lookPost(clip?.look, clip?.lookAmount);
    if (!post || alpha <= 0 || rw <= 0 || rh <= 0) return;
    const canvas = target?.canvas ?? this.canvas;
    const ctx = target?.ctx ?? this.ctx();
    if (!ctx || !("filter" in ctx)) return;
    const W = canvas.width;
    const H = canvas.height;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rx, ry, rw, rh);
    ctx.clip();
    if (post.glow) {
      // Copy the just-drawn region through a blur (and a highlight isolation
      // for halation) and lay it back over itself.
      const { surface: scratch } = this.scratch("lookScratch", W, H);
      const sctx = scratch.getContext("2d") as Ctx | null;
      if (sctx && "filter" in sctx) {
        const blurPx = Math.max(1, post.glow.blurFrac * H);
        sctx.clearRect(rx, ry, rw, rh);
        sctx.filter = post.glow.bright
          ? `contrast(2.5) brightness(0.55) saturate(1.4) sepia(0.35) blur(${blurPx}px)`
          : `blur(${blurPx}px)`;
        sctx.drawImage(canvas, rx, ry, rw, rh, rx, ry, rw, rh);
        sctx.filter = "none";
        ctx.globalAlpha = post.glow.alpha * alpha;
        ctx.globalCompositeOperation = post.glow.mode;
        ctx.drawImage(scratch, rx, ry, rw, rh, rx, ry, rw, rh);
      }
    }
    if (post.ghost) {
      // VHS chroma fringing: warm and cool copies of the region nudged apart.
      const { surface: scratch } = this.scratch("lookScratch", W, H);
      const sctx = scratch.getContext("2d") as Ctx | null;
      if (sctx && "filter" in sctx) {
        const shift = Math.max(1, post.ghost.shiftFrac * W);
        sctx.clearRect(rx, ry, rw, rh);
        sctx.filter = "sepia(1) saturate(4) hue-rotate(-40deg) brightness(0.55)";
        sctx.drawImage(canvas, rx, ry, rw, rh, rx, ry, rw, rh);
        sctx.filter = "none";
        ctx.globalAlpha = post.ghost.alpha * alpha;
        ctx.globalCompositeOperation = "lighter";
        ctx.drawImage(scratch, rx, ry, rw, rh, rx + shift, ry, rw, rh);
        sctx.clearRect(rx, ry, rw, rh);
        sctx.filter = "sepia(1) saturate(4) hue-rotate(140deg) brightness(0.55)";
        sctx.drawImage(canvas, rx, ry, rw, rh, rx, ry, rw, rh);
        sctx.filter = "none";
        ctx.drawImage(scratch, rx, ry, rw, rh, rx - shift, ry, rw, rh);
      }
    }
    ctx.globalCompositeOperation = "source-over";
    for (const wash of post.washes ?? []) {
      ctx.globalAlpha = wash.alpha * alpha;
      ctx.globalCompositeOperation = wash.mode;
      ctx.fillStyle = wash.color;
      ctx.fillRect(rx, ry, rw, rh);
    }
    if (post.grain) {
      const tile = grainTile(Math.floor(at / GRAIN_STEP));
      if (tile) {
        ctx.globalAlpha = post.grain * alpha;
        ctx.globalCompositeOperation = "overlay";
        for (let y = ry; y < ry + rh; y += tile.height) {
          for (let x = rx; x < rx + rw; x += tile.width) {
            ctx.drawImage(tile, x, y);
          }
        }
      }
    }
    if (post.vignette) {
      // Cached radial gradient, rebuilt only when the footprint size changes.
      const vw = Math.max(1, Math.round(rw));
      const vh = Math.max(1, Math.round(rh));
      const { surface: vg, resized } = this.scratch("vignetteCanvas", vw, vh);
      if (resized) {
        const vctx = vg.getContext("2d") as Ctx | null;
        if (vctx) {
          const g = vctx.createRadialGradient(
            vw / 2,
            vh / 2,
            Math.min(vw, vh) * 0.35,
            vw / 2,
            vh / 2,
            Math.hypot(vw, vh) / 2
          );
          g.addColorStop(0, "rgba(0,0,0,0)");
          g.addColorStop(1, "rgba(0,0,0,1)");
          vctx.clearRect(0, 0, vw, vh);
          vctx.fillStyle = g;
          vctx.fillRect(0, 0, vw, vh);
        }
      }
      ctx.globalAlpha = post.vignette * alpha;
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(vg, rx, ry, rw, rh);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /** Whether the layer routes through the mask/pose pass at all. */
  private needsFx(clip?: VideoClip): boolean {
    return (
      !!clip &&
      (clipPosed(clip) ||
        !!clip.boxStyle?.shadow ||
        !!(clip.mask && (clip.mask.kind !== "subject" || this.subjectMatteProvider)))
    );
  }

  /**
   * Draw one masked or keyframed layer by re-entering `draw` against a
   * transparent scratch (with the clip's mask and keys stripped so the inner
   * call draws plainly), then compose in order: the geometry mask trims the
   * layer in its own space (it rides the clip), the pose blits the result
   * where the keys put it, and the person matte — anchored to the frame, so
   * the person never travels with the clip — trims last. The mask and pose
   * evaluate on the clip's own clock.
   */
  private drawFx(
    clip: VideoClip,
    at: number,
    fx: LayerFx | undefined,
    draw: (plain: VideoClip) => void
  ) {
    const ctx = this.ctx();
    if (!ctx) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const tLocal = Math.max(0, at - clip.start);
    const pose = clipPosed(clip) ? clipPoseAt(clip, tLocal) : null;
    if (pose && pose.opacity <= 0.001) return;
    const mask = clip.mask;
    const { surface: layer } = this.scratch("layerScratch", W, H);
    const lctx = layer.getContext("2d") as Ctx | null;
    if (!lctx) return;
    lctx.clearRect(0, 0, W, H);
    const prev = this.canvas;
    this.canvas = layer;
    try {
      // The pose pass owns the turn and the fade; the inner draw takes the
      // picture plain, or it would apply them a second time (and re-enter
      // here forever).
      draw({
        ...clip,
        mask: undefined,
        kf: undefined,
        rotation: undefined,
        opacity: undefined,
        ...(clip.boxStyle ? { boxStyle: { ...clip.boxStyle, shadow: undefined } } : {}),
      });
    } finally {
      this.canvas = prev;
    }
    const rect = rectOf(clip);
    const { surface: cover } = this.scratch("maskScratch", W, H);
    if (mask && mask.kind !== "subject") {
      applyMaskToCanvas(
        lctx,
        cover,
        mask,
        tLocal,
        { width: W, height: H, scale: Math.min(W, H) / 1080 },
        { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
      );
    }
    let out: Surface = layer;
    let octx = lctx;
    if (pose) {
      const { surface: posed } = this.scratch("poseScratch", W, H);
      const pctx = posed.getContext("2d") as Ctx | null;
      if (!pctx) return;
      pctx.setTransform(1, 0, 0, 1, 0, 0);
      pctx.clearRect(0, 0, W, H);
      pctx.save();
      pctx.globalAlpha = Math.max(0, Math.min(1, pose.opacity));
      pctx.translate(pose.x * W, pose.y * H);
      pctx.rotate((pose.rotation * Math.PI) / 180);
      pctx.scale(pose.scale, pose.scale);
      pctx.translate(-(rect.x + rect.w / 2) * W, -(rect.y + rect.h / 2) * H);
      pctx.drawImage(layer, 0, 0);
      pctx.restore();
      out = posed;
      octx = pctx;
    }
    if (mask?.kind === "subject") {
      // The person matte is the coverage: blur its edge by the feather and
      // multiply it in (or out, inverted), after the pose so the person
      // stays anchored to the frame. A computed frame with no person means
      // empty coverage — a front-masked layer shows nothing (the export's
      // black matte frames land the same way) and a behind-masked one shows
      // whole.
      const res = this.subjectMatteProvider?.(at) ?? null;
      if (res && !res.alpha) {
        if (!mask.invert) return;
      } else if (res?.alpha) {
        const cctx = cover.getContext("2d") as Ctx;
        cctx.clearRect(0, 0, W, H);
        const feather = (mask.feather ?? 0) * (Math.min(W, H) / 1080);
        if (feather > 0 && "filter" in cctx) cctx.filter = `blur(${feather / 2}px)`;
        cctx.imageSmoothingEnabled = true;
        cctx.drawImage(res.alpha, 0, 0, W, H);
        cctx.filter = "none";
        maskComposite(octx, cover as CanvasImageSource, mask.invert);
      }
    }
    // Transition motion lands on the finished result, so a push carries the
    // mask and pose along — the export translates the segment the same way.
    const hasFx = !!fx && (!!fx.dx || !!fx.dy);
    if (hasFx) {
      ctx.save();
      ctx.translate(Math.round(fx.dx ?? 0), Math.round(fx.dy ?? 0));
    }
    const shade = this.shadowOf(out, clip.boxStyle?.shadow);
    if (shade) ctx.drawImage(shade, 0, 0);
    ctx.drawImage(out, 0, 0);
    if (hasFx) ctx.restore();
  }

  /**
   * The shadow a finished layer casts: the layer blurred and thrown behind
   * itself, with the layer's own shape punched back out. What is left is the
   * shadow alone, so it can be laid down before the picture (here) or over the
   * frame beside it (the export's painted PNG) and look the same either way.
   * Null when the clip casts none.
   */
  private shadowOf(layer: Surface, sh: ClipShadow | undefined): Surface | null {
    const ctx = this.ctx();
    if (!ctx || !sh) return null;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const { surface } = this.scratch("shadowScratch", W, H);
    const sctx = surface.getContext("2d") as Ctx | null;
    if (!sctx) return null;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalCompositeOperation = "source-over";
    sctx.clearRect(0, 0, W, H);
    // Shadow lengths are design px at the 1080 short side, like masks.
    const ds = Math.min(W, H) / 1080;
    sctx.save();
    sctx.shadowColor = shadowInk(sh);
    sctx.shadowBlur = Math.max(0, sh.blur) * ds;
    sctx.shadowOffsetX = (sh.x ?? 0) * ds;
    sctx.shadowOffsetY = (sh.y ?? 0) * ds;
    sctx.drawImage(layer as CanvasImageSource, 0, 0);
    sctx.restore();
    sctx.globalCompositeOperation = "destination-out";
    sctx.drawImage(layer as CanvasImageSource, 0, 0);
    sctx.globalCompositeOperation = "source-over";
    return surface;
  }

  /** Draw a frame into a sub-rectangle of the canvas (a split-screen half, an
   * overlay's region), fitted or filled. */
  drawIntoRect(
    frame: Frame,
    rect: FrameRect,
    fill: boolean,
    alpha: number,
    at: number,
    zoom = 1,
    clip?: VideoClip
  ) {
    if (frame.kind !== "ready") return;
    if (this.needsFx(clip)) {
      this.drawFx(clip!, at, undefined, (plain) =>
        this.drawIntoRect(frame, rect, fill, alpha, at, zoom, plain)
      );
      return;
    }
    const ctx = this.ctx();
    if (!ctx) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const rx = rect.x * W;
    const ry = rect.y * H;
    const rw = rect.w * W;
    const rh = rect.h * H;
    // The clip's own zoom rides on the transition's, so a cross zoom over a
    // zoomed clip pushes in from where the clip already sits.
    const {
      x: dx,
      y: dy,
      w: dw,
      h: dh,
    } = contentRect(
      { x: rx, y: ry, w: rw, h: rh },
      frame.width,
      frame.height,
      fill,
      clipZoom(clip ?? {}) * zoom,
      clip?.panX ?? 0,
      clip?.panY ?? 0
    );
    const src = this.removedSource(frame, clip, at);
    const bs = clip?.boxStyle;
    // Box style lengths are design px at the 1080 short side, like masks.
    const ds = Math.min(W, H) / 1080;
    const rad = Math.max(0, (bs?.radius ?? 0) * ds);
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    const clipped = fill || dw > rw + 0.5 || dh > rh + 0.5 || rad > 0;
    const flipped = !!(clip?.flipH || clip?.flipV);
    if (clipped || flipped) {
      ctx.save();
      if (clipped) {
        ctx.beginPath();
        ctx.roundRect(rx, ry, rw, rh, rad);
        ctx.clip();
      }
      if (flipped) {
        // The mirror turns about the box center, so the framed picture stays
        // in its box and the mask and pose passes see it where it was.
        ctx.translate(rx + rw / 2, ry + rh / 2);
        ctx.scale(clip?.flipH ? -1 : 1, clip?.flipV ? -1 : 1);
        ctx.translate(-(rx + rw / 2), -(ry + rh / 2));
      }
      ctx.drawImage(src, dx, dy, dw, dh);
      ctx.restore();
    } else {
      ctx.drawImage(src, dx, dy, dw, dh);
    }
    if (bs?.borderWidth) {
      // Stroke inside the box edge, so the border never widens the region.
      const bw = bs.borderWidth * ds;
      ctx.strokeStyle = bs.borderColor ?? "#ffffff";
      ctx.lineWidth = bw;
      ctx.beginPath();
      ctx.roundRect(rx + bw / 2, ry + bw / 2, rw - bw, rh - bw, Math.max(0, rad - bw / 2));
      ctx.stroke();
    }
    ctx.globalAlpha = prevAlpha;
    this.applyLookPost(clip, rx, ry, rw, rh, alpha, at);
  }

  /**
   * Draw one clip's layer over the frame, honouring its region, fit, pan, zoom,
   * alpha and any frame motion a transition puts on it.
   *
   * `clear` says this layer owns the black behind it. A layer with nothing to
   * draw takes the black with it; a layer whose picture merely hasn't arrived
   * leaves the frame as it stands.
   */
  drawLayer(
    frame: Frame,
    clip: VideoClip | undefined,
    clear: boolean,
    alpha: number,
    at: number,
    zoom = 1,
    fx?: LayerFx
  ) {
    const ctx = this.ctx();
    if (!ctx) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const blank = () => {
      if (clear) {
        ctx.fillStyle = this.background;
        ctx.fillRect(0, 0, W, H);
      }
    };
    // A hidden clip plays nothing, and a clip with no picture at all yields the
    // frame; both fill black only when they own the clear.
    if (frame.kind === "missing" || clip?.hidden) return blank();
    // Mid-seek there is no decodable frame; keep the previous one on the canvas
    // instead of strobing black (matters while skimming).
    if (frame.kind === "pending") return;
    blank();
    if (this.needsFx(clip)) {
      // The blank above already settled who owns the black; the layer itself
      // draws through the mask/pose pass, and any transition motion lands on
      // the finished result.
      this.drawFx(clip!, at, fx, (plain) =>
        this.drawLayer(frame, plain, false, alpha, at, zoom, undefined)
      );
      return;
    }

    const hasFx = !!fx && (!!fx.dx || !!fx.dy);
    if (hasFx) {
      // Motion runs in full-canvas space — the export translates the whole
      // padded segment frame, so a regioned clip rides along with it.
      // Whole-pixel translation: a fractional offset antialiases both frame
      // edges and draws a hairline seam where a push's frames meet.
      ctx.save();
      ctx.translate(Math.round(fx.dx ?? 0), Math.round(fx.dy ?? 0));
    }
    // A regioned track-0 clip (split-screen half) draws into its rect over the
    // black frame; the full-frame path below keeps the pan-crop behavior. A
    // styled box (rounded corners, border) or a mirrored picture also routes
    // through the rect path, which knows how to draw those at full frame too.
    const rect = rectOf(clip ?? {});
    if (!isFullRect(rect) || clip?.boxStyle || clip?.flipH || clip?.flipV) {
      this.drawIntoRect(frame, rect, !!clip && clipCovers(clip), alpha, at, zoom, clip);
      if (hasFx) ctx.restore();
      return;
    }
    const fill = !!clip && clipCovers(clip);
    const {
      x: dx,
      y: dy,
      w: dw,
      h: dh,
    } = contentRect(
      { x: 0, y: 0, w: W, h: H },
      frame.width,
      frame.height,
      fill,
      clipZoom(clip ?? {}) * zoom,
      clip?.panX ?? 0,
      clip?.panY ?? 0
    );
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.drawImage(this.removedSource(frame, clip, at), dx, dy, dw, dh);
    ctx.globalAlpha = prevAlpha;
    this.applyLookPost(clip, 0, 0, W, H, alpha, at);
    if (hasFx) ctx.restore();
  }

  /**
   * Draw the outgoing and incoming clips of a transition at progress `p`
   * (0..1), in the geometry the style calls for: a blend, a dip through a
   * colour, a push, a wipe, or a shape reveal.
   */
  drawCrossJoin(style: TransitionStyle, p: number, d: CrossJoin, at: number) {
    const ctx = this.ctx();
    if (!ctx) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const drawMaster = (fx = d.masterFx, alpha = d.masterAlpha) =>
      this.drawLayer(d.masterFrame, d.masterClip, false, alpha, at, d.masterZoom, fx);
    // The blend styles ramp the incoming alpha; the geometric styles draw it
    // opaque inside their own moving region.
    const drawInc = (alpha = d.incAlpha, fx?: LayerFx) => {
      this.drawLayer(d.incFrame, d.incClip, false, alpha, at, d.incZoom, fx);
    };
    const clipped = (path: () => void, draw: () => void) => {
      ctx.save();
      ctx.beginPath();
      path();
      ctx.clip();
      draw();
      ctx.restore();
    };
    // Only the absence of an incoming clip cancels the transition. One whose
    // picture merely hasn't decoded yet still runs the layered styles: a dip's
    // veil and a fade's ramp sit over the master, so the geometry is what the
    // frame should look like mid-transition. The region styles are different —
    // a push shoves the master aside and a circle carves it away, and with no
    // incoming picture yet the vacated region renders black — so those hold
    // the master in place until the frame decodes.
    if (d.incFrame.kind === "missing" || p <= 0) {
      drawMaster();
      return;
    }
    const carves =
      style.startsWith("push") ||
      style.startsWith("wipe") ||
      style.startsWith("circle") ||
      style.startsWith("split");
    if (carves && d.incFrame.kind === "pending") {
      drawMaster();
      return;
    }
    switch (style) {
      case "dipblack":
      case "dipwhite": {
        // Matches xfade fadeblack/fadewhite's measured plateau: out by ~30%,
        // solid to ~60%, in over the rest.
        const veil = Math.max(0, Math.min(1, Math.min(p / 0.3, (1 - p) / 0.4)));
        if (p < 0.45) drawMaster();
        else drawInc(1);
        this.fillVeil(style === "dipwhite" ? "255,255,255" : "0,0,0", veil);
        break;
      }
      case "blur": {
        // Defocus blend: blur peaks mid-transition on both sides (isotropic
        // here vs ffmpeg's horizontal hblur — reads the same). Without
        // ctx.filter this degrades to the plain crossfade below.
        const supports = "filter" in ctx;
        const r = Math.max(0.5, (Math.min(W, H) / 24) * (1 - Math.abs(2 * p - 1)));
        if (supports) ctx.filter = `blur(${r.toFixed(2)}px)`;
        drawMaster();
        drawInc();
        if (supports) ctx.filter = "none";
        break;
      }
      case "pushleft":
      case "pushright":
      case "pushup":
      case "pushdown": {
        // Both frames travel together; the incoming clip shoves the outgoing
        // one off the named edge.
        const [mx, my, ix, iy] =
          style === "pushleft"
            ? [-p * W, 0, (1 - p) * W, 0]
            : style === "pushright"
              ? [p * W, 0, -(1 - p) * W, 0]
              : style === "pushup"
                ? [0, -p * H, 0, (1 - p) * H]
                : [0, p * H, 0, -(1 - p) * H];
        drawMaster({ ...d.masterFx, dx: d.masterFx.dx + mx, dy: d.masterFx.dy + my });
        drawInc(1, { dx: ix, dy: iy });
        break;
      }
      case "wipeleft":
      case "wiperight":
      case "wipeup":
      case "wipedown": {
        // Hard reveal edge traveling in the named direction.
        const r =
          style === "wipeleft"
            ? { x: (1 - p) * W, y: 0, w: p * W, h: H }
            : style === "wiperight"
              ? { x: 0, y: 0, w: p * W, h: H }
              : style === "wipeup"
                ? { x: 0, y: (1 - p) * H, w: W, h: p * H }
                : { x: 0, y: 0, w: W, h: p * H };
        drawMaster();
        clipped(
          () => ctx.rect(r.x, r.y, r.w, r.h),
          () => drawInc(1)
        );
        break;
      }
      case "circleopen": {
        drawMaster();
        clipped(
          () => ctx.arc(W / 2, H / 2, (p * Math.hypot(W, H)) / 2, 0, Math.PI * 2),
          () => drawInc(1)
        );
        break;
      }
      case "circleclose": {
        // The outgoing picture collapses into a shrinking circle over the
        // incoming one.
        drawInc(1);
        clipped(
          () => ctx.arc(W / 2, H / 2, ((1 - p) * Math.hypot(W, H)) / 2, 0, Math.PI * 2),
          () => drawMaster()
        );
        break;
      }
      case "splitopen": {
        // Barn doors part from the center.
        drawMaster();
        clipped(
          () => ctx.rect(((1 - p) * W) / 2, 0, p * W, H),
          () => drawInc(1)
        );
        break;
      }
      case "splitclose": {
        // The incoming picture closes in from both side edges.
        drawMaster();
        clipped(
          () => {
            ctx.rect(0, 0, (p * W) / 2, H);
            ctx.rect(W - (p * W) / 2, 0, (p * W) / 2, H);
          },
          () => drawInc(1)
        );
        break;
      }
      default: {
        // crossfade / crosszoom: the classic A·(1−α)+B·α blend (zooms already
        // folded into the layer zoom factors).
        drawMaster();
        drawInc();
      }
    }
  }
}
