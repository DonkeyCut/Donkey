"use client";

/**
 * The subject-mask pass, shared by the live preview and the in-tab export.
 * The person matte drives two things: elements behind the speaker (with the
 * video layers already on the canvas, snapshot them, draw the behind-tagged
 * rasters, then segment the snapshot and draw the person back on top) and
 * elements or clips trimmed to the speaker. When no person registers the
 * behind effect degrades to the plain picture.
 */

import {
  applyWordDraw,
  countStep,
  countText,
  cutAtFaces,
  diveView,
  divesAt,
  erodeLevel,
  evalOverlayFrame,
  fontCycleCuts,
  measureDiveFocus,
  peekDiveFocus,
  glyphStateAt,
  hasGlyphMotion,
  maskComposite,
  overlayWords,
  paintElementCrop,
  typedChars,
  withFontCycle,
  wordSampleWindows,
  zapSeed,
  type OverlayFrameState,
  type PaintPhase,
  type ZapPhase,
} from "@donkeycut/effects-kit";
import { ElementFx, elementLook } from "@donkeycut/effects-kit";
import { personSegmenter, segmentSubjectAlpha } from "./cutout";
import { allowance, holdMemory } from "./memoryBudget";
import { createRasterCanvas, snapshotRaster } from "./raster";
import { cutRenderEnv } from "./textRender";
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

/** An element's own length, the span its word emphasis is timed across. */
const spanOf = (o: Overlay): number => Math.max(0.1, o.end - o.start);

/** Pictures here are full-frame, so a word effect that ramps is sampled
 * coarsely: enough slices that an arrival reads, few enough that a behind-
 * subject line does not hold a hundred frames of pixels resident. */
const BEHIND_WORD_FPS = 8;

/** The spans an element's word effect holds still for — one picture each.
 * Nothing here means the element draws as one piece. */
function rasterSpans(o: Overlay): { start: number; end: number }[] | null {
  if (!isTextOverlay(o)) return null;
  // A font cycle changes the type at every step: each face gets its own
  // picture, cut inside the word spans when both run.
  const words = overlayWords(o);
  const faces = fontCycleCuts(o, spanOf(o));
  if (!words && faces.length === 0) return null;
  const base = words ? wordSampleWindows(o.text, words, spanOf(o), BEHIND_WORD_FPS) : [{ start: 0, end: spanOf(o) }];
  const spans = cutAtFaces(base, faces);
  return spans.length > 0 ? spans : null;
}

/** The picture indices an element needs: one per span while a word effect
 * walks it, and the plain picture (-1) otherwise. */
function rasterSlices(o: Overlay): number[] {
  const spans = rasterSpans(o);
  return spans ? spans.map((_, i) => i) : [-1];
}

/** Which picture stands for `tLocal`, or -1 for the plain one. */
function rasterSliceAt(o: Overlay, tLocal: number): number {
  const spans = rasterSpans(o);
  if (!spans) return -1;
  const i = spans.findIndex((s) => tLocal >= s.start && tLocal < s.end);
  return i < 0 ? spans.length - 1 : i;
}

/**
 * Which picture an element needs at one moment: its word slice, how many
 * characters a typewriter has typed (-1 = the whole text), and whether the
 * typing bar is lit — the same reading the front path's painters take from
 * the evaluator. A whole-text picture keys at zero or above (two per word
 * slice, bar dark and lit); a typing picture keys below zero, one per typed
 * count, and a counting picture likewise, one per step its numbers take.
 * A disintegrating or crackling moment keys below zero too, one picture per
 * erosion step and arc deal.
 */
interface Look {
  key: number;
  word: number;
  chars: number;
  caret: boolean;
  /** Where a counting picture's numbers stand, 0..1 (count). */
  count?: number;
  /** The share of the ink a disintegration has eaten, at its erosion step. */
  erode?: number;
  /** The arcs a zap hit paints over the picture. */
  zap?: ZapPhase;
}

/** The picture `o` needs at `tLocal`. */
function lookAt(o: Overlay, tLocal: number, ev: OverlayFrameState): Look {
  const word = rasterSliceAt(o, tLocal);
  const caret = ev.caret === true;
  const n = isTextOverlay(o) ? [...o.text].length : 0;
  const chars = isTextOverlay(o) && ev.textProgress !== undefined ? typedChars(o.text, ev.textProgress) : -1;
  const bar = caret ? 1 : 0;
  // A count keys its pictures by how far its numbers have counted, out of
  // every step they take ("100 %" takes 100).
  const count = isTextOverlay(o) ? ev.countProgress : undefined;
  const text = isTextOverlay(o) ? o.text : "";
  const step = count !== undefined ? countStep(text, count) : chars;
  const steps = count !== undefined ? countStep(text, 1) : n;
  // An erosion step and an arc deal fold into a phase slot: 0 is neither,
  // e.g. step 3 under deal 5 is 3 + 25 × 6 with 24 erosion steps.
  const level = ev.erode !== undefined ? erodeLevel(ev.erode) : 0;
  const zap = ev.zap ? { amount: ev.zap, seed: zapSeed(tLocal) } : undefined;
  const levels = erodeLevel(1) + 1;
  const phase = level + levels * (zap ? zap.seed + 1 : 0);
  const phases = levels * (zapSeed(spanOf(o)) + 2);
  const picture = ((word + 1) * (steps + 2) + step + 1) * 2 + bar;
  const key = step < 0 && phase === 0 ? (word + 1) * 2 + bar : -1 - (picture * phases + phase);
  return {
    key,
    word,
    chars,
    caret,
    ...(count !== undefined ? { count } : {}),
    ...(level > 0 ? { erode: level / (levels - 1) } : {}),
    ...(zap ? { zap } : {}),
  };
}

/** The phase a picture with its typing bar lit is painted at. */
const CARET_LIT: PaintPhase = { caret: true };

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

/** Element pictures the pass may hold: the elements live on one frame are a
 * handful of full-size pictures, and a play through the cut reaches every
 * element in it. */
const RASTER_TUNED = 48 * 2 ** 20;

/** What one element's pictures cost: one per word it lights, four bytes a
 * pixel, at the size of the frame they are drawn on. */
const entryBytes = (e: { byWord: Map<number, ImageBitmap> }): number => {
  let n = 0;
  for (const b of e.byWord.values()) n += b.width * b.height * 4;
  return n;
};

/** One element's pictures: whole-text ones by word slice and bar, and the
 * typing picture it is on. `pending` holds the keys being drawn, `want` the
 * typing picture it is waiting for, and `typedAt` when the pump last served
 * it, so elements typing at once take turns. */
interface RasterEntry {
  of: Overlay;
  byWord: Map<number, ImageBitmap>;
  pending: Set<number>;
  usedAt: number;
  last: ImageBitmap | null;
  want: Look | null;
  typedAt: number;
}

export class SubjectMaskCompositor {
  /** `publishes` marks the live preview's instance, the one whose matte the
   * DOM layer reads. */
  constructor(private publishes = false) {}

  private segmenter: Segmenter | null = null;
  private segKicked = false;
  /**
   * One picture per element, and one per emphasized word when the element
   * lights its words as they are said.
   *
   * Filed under the element's id and stamped with the element object the
   * picture was drawn from. The store hands back a new object for every edit,
   * so a stamp that no longer matches is a picture of an element that has since
   * changed: it closes and redraws. Keying on the object itself would say the
   * same thing, and would leave every superseded picture holding pixels outside
   * the heap that only `close()` gives back, with a keystroke's worth minted
   * per keystroke.
   *
   * `pending` rides in the entry so it is dropped whenever the pictures are.
   * It marks a draw already asked for, and a marker outliving the picture it
   * was asked for would leave the element blank for good.
   */
  private rasters = new Map<string, RasterEntry>();
  /** Typing pictures are painted one at a time on this surface: a typed
   * count is a picture shown for a frame or two, so it skips the PNG round
   * trip, and an element that types faster than the pictures land shows the
   * latest count it reached. */
  private typeSurface: HTMLCanvasElement | null = null;
  private typing = false;
  /** Typing pictures painted, the clock the pump takes turns on. */
  private typed = 0;
  private typeArgs: { w: number; h: number; assets: MediaAsset[] } = { w: 1, h: 1, assets: [] };
  /** Frames this pass has drawn, which is the clock the pictures are given
   * back on: an element drawn on the frame being composited is the one the
   * next frame will ask for again. */
  private pass = 0;
  private readonly releaseMemory = holdMemory("overlayRasters", () => {
    let n = 0;
    for (const e of this.rasters.values()) n += entryBytes(e);
    const typing = this.typeSurface ? this.typeSurface.width * this.typeSurface.height * 4 : 0;
    return n + this.fx.bytes() + typing;
  });
  private person: HTMLCanvasElement | null = null;
  /** Scratch for blurred and motion-blurred behind elements. */
  private fx = new ElementFx(createRasterCanvas);
  /** Where each picture's top-left sits in the frame: pictures are cropped to
   * the element's ink, however far past the frame it reaches, so a pose that
   * shrinks an oversize element keeps its edges. */
  private origins = new WeakMap<ImageBitmap, { x: number; y: number }>();
  /** The crop's mask scratch, made on first use. */
  private cropMask: HTMLCanvasElement | null = null;
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

  /** This element's entry, emptied first when the pictures in it were drawn
   * from an older version of the element. */
  private entryFor(o: Overlay) {
    let entry = this.rasters.get(o.id);
    if (entry && entry.of !== o) {
      for (const b of entry.byWord.values()) b.close();
      entry.byWord.clear();
      entry.pending.clear();
      entry.of = o;
      entry.last = null;
      entry.want = null;
    }
    if (!entry) {
      entry = {
        of: o,
        byWord: new Map(),
        pending: new Set(),
        usedAt: this.pass,
        last: null,
        want: null,
        typedAt: -1,
      };
      this.rasters.set(o.id, entry);
    }
    entry.usedAt = this.pass;
    return entry;
  }

  /**
   * Give back the pictures of the elements this pass has gone longest without
   * drawing, once what it holds is past its share.
   *
   * A picture is one full-size frame per element, so a play through a cut
   * whose elements come and go leaves the pass holding every one it has ever
   * drawn. What a frame is drawing was drawn on the frame before it, so the
   * live ones are the youngest and stay; an element the playhead has left
   * draws again from scratch when it is next reached.
   */
  private sweepRasters(): void {
    const cap = allowance("overlayRasters", RASTER_TUNED);
    let held = 0;
    for (const e of this.rasters.values()) held += entryBytes(e);
    if (held <= cap) return;
    for (const [id, e] of [...this.rasters].sort((a, b) => a[1].usedAt - b[1].usedAt)) {
      if (held <= cap) break;
      // The sweep runs at the head of a pass, before anything this frame is
      // stamped, so the frame's own pictures are the ones the pass before it
      // drew. Dropping those would close bitmaps the next draw asks for and
      // decode them again.
      if (e.usedAt >= this.pass - 1) continue;
      held -= entryBytes(e);
      for (const b of e.byWord.values()) b.close();
      this.rasters.delete(id);
    }
  }

  /**
   * The picture `look` names, or while it is being drawn the last one this
   * element landed, so a typing title moves on a frame late and never blinks
   * out.
   */
  private rasterFor(o: Overlay, look: Look, w: number, h: number, assets: MediaAsset[]): ImageBitmap | null {
    const entry = this.entryFor(o);
    const hit = entry.byWord.get(look.key);
    if (hit) return hit;
    if (look.key >= 0) {
      // Done typing: a typed count still queued is a picture nothing shows.
      entry.want = null;
      if (entry.pending.has(look.key)) return entry.last;
      entry.pending.add(look.key);
      // Neutral picture: position aside, the per-frame pose owns rotation and
      // opacity, so baking them here would apply each of them twice.
      void this.drawRaster(o, w, h, assets, look.key, look.word, look.caret).catch(() => {});
      return entry.last;
    }
    if (!entry.pending.has(look.key)) entry.want = look;
    this.typeArgs.w = w;
    this.typeArgs.h = h;
    this.typeArgs.assets = assets;
    this.pumpTyping();
    return entry.last;
  }

  /** The element as one picture shows it: its words as they stand across
   * the span the picture covers, `chars` of its text typed (-1 = all), its
   * numbers counted to `count`. */
  private pictureOf(o: Overlay, word: number, count?: number): Overlay {
    const spans = rasterSpans(o);
    const span = word >= 0 ? spans?.[word] : undefined;
    const at = span ? (span.start + span.end) / 2 : 0;
    const el = withFontCycle(applyWordDraw({ ...o, rotation: undefined, opacity: undefined }, at, spanOf(o)), at);
    if (count !== undefined && isTextOverlay(el)) {
      return { ...el, text: countText(el.text, count) };
    }
    return el;
  }

  /** One whole-text picture, kept under the element it came from. */
  private async drawRaster(
    o: Overlay,
    w: number,
    h: number,
    assets: MediaAsset[],
    key: number,
    word: number,
    caret: boolean
  ): Promise<void> {
    const surface = scratchCanvas();
    const origin = await paintElementCrop(surface, this.pictureOf(o, word), w, h, cutRenderEnv(assets), {
      t: 0,
      phase: caret ? CARET_LIT : undefined,
      maskScratch: (this.cropMask ??= scratchCanvas()),
    });
    const bmp = await snapshotRaster(surface);
    surface.width = surface.height = 1;
    this.origins.set(bmp, origin);
    this.land(o, key, bmp);
  }

  /** One typing picture, painted on the shared surface. */
  private async drawTyped(o: Overlay, w: number, h: number, assets: MediaAsset[], look: Look): Promise<void> {
    const surface = (this.typeSurface ??= scratchCanvas());
    // A typing picture keeps the whole text's layout and shows its typed head.
    // A disintegrating or crackling picture carries its erosion and arcs.
    const typing: PaintPhase | undefined = look.chars >= 0 ? { typed: look.chars } : undefined;
    const lived: PaintPhase = {
      ...(look.caret ? CARET_LIT : {}),
      ...typing,
      ...(look.erode !== undefined ? { erode: look.erode } : {}),
      ...(look.zap ? { zap: look.zap } : {}),
    };
    const origin = await paintElementCrop(surface, this.pictureOf(o, look.word, look.count), w, h, cutRenderEnv(assets), {
      t: 0,
      phase: Object.keys(lived).length > 0 ? lived : undefined,
      maskScratch: (this.cropMask ??= scratchCanvas()),
    });
    const bmp = await snapshotRaster(surface);
    this.origins.set(bmp, origin);
    this.land(o, look.key, bmp);
  }

  /** Paint the typing pictures elements are waiting on, one after another,
   * each at the latest count its element asked for. Elements typing at once
   * take turns: the one served longest ago goes next. */
  private pumpTyping(): void {
    if (this.typing) return;
    this.typing = true;
    void (async () => {
      try {
        for (;;) {
          let next: RasterEntry | null = null;
          for (const e of this.rasters.values()) {
            if (e.want && (!next || e.typedAt < next.typedAt)) next = e;
          }
          if (!next) break;
          const entry = next;
          const look = entry.want!;
          entry.want = null;
          entry.typedAt = this.typed++;
          entry.pending.add(look.key);
          const { w, h, assets } = this.typeArgs;
          await this.drawTyped(entry.of, w, h, assets, look).catch(() => entry.pending.delete(look.key));
        }
      } finally {
        this.typing = false;
      }
    })();
  }

  /** File a finished picture. Any typing picture it supersedes goes: an
   * element holds one typed count at a time, however long it types. */
  private land(o: Overlay, key: number, bmp: ImageBitmap): void {
    // The element may have been edited, or the pictures released, while this
    // one was being drawn; either way its entry is gone or stamped with a
    // different object, and this picture is of the wrong thing.
    const entry = this.rasters.get(o.id);
    if (!entry || entry.of !== o) {
      bmp.close();
      return;
    }
    entry.pending.delete(key);
    for (const [k, b] of entry.byWord) {
      if (k >= 0 || k === key) continue;
      b.close();
      entry.byWord.delete(k);
    }
    entry.byWord.get(key)?.close();
    entry.byWord.set(key, bmp);
    entry.last = bmp;
  }

  /** Export path: the picture every behind element needs at `t`, drawn
   * before the frame is, so no frame of a render shows a stale one. */
  async ready(overlays: Overlay[], w: number, h: number, assets: MediaAsset[], t: number): Promise<void> {
    for (const o of overlays) {
      if (!behindSubjectOverlay(o) || !drawable(o) || t < o.start || t > o.end) continue;
      const tLocal = Math.max(0, t - o.start);
      const look = lookAt(o, tLocal, evalOverlayFrame(o, tLocal, w / h));
      if (this.entryFor(o).byWord.has(look.key)) continue;
      try {
        if (look.key < 0) await this.drawTyped(o, w, h, assets, look);
        else await this.drawRaster(o, w, h, assets, look.key, look.word, look.caret);
      } catch {
        // The overlay just draws in front when its raster is missing.
      }
    }
  }

  /** Give back every picture this pass is holding. The pass stays usable and
   * draws them again when it is next asked. */
  clear(): void {
    for (const e of this.rasters.values()) for (const b of e.byWord.values()) b.close();
    this.rasters.clear();
  }

  /** Give the pictures back and stop reporting what this pass holds. */
  dispose(): void {
    this.clear();
    this.fx.dispose();
    if (this.typeSurface) {
      this.typeSurface.width = 1;
      this.typeSurface.height = 1;
      this.typeSurface = null;
    }
    if (this.cropMask) {
      this.cropMask.width = this.cropMask.height = 1;
      this.cropMask = null;
    }
    this.releaseMemory();
  }

  /** Export path: everything resident before the first frame draws. */
  async prepare(overlays: Overlay[], w: number, h: number, assets: MediaAsset[]): Promise<void> {
    this.ensureSegmenter();
    await personSegmenter().then((s) => {
      this.segmenter = s;
    });
    const behind = overlays.filter((o) => behindSubjectOverlay(o) && drawable(o));
    await Promise.all(
      behind.filter((o) => divesAt(o.anim)).map((o) =>
        measureDiveFocus(o, w / h, cutRenderEnv(assets)).catch(() => {})
      )
    );
    await Promise.all(
      behind.flatMap((o) =>
        // An element that lights its words needs one picture per word, all of
        // them resident before the first frame draws.
        rasterSlices(o).map(async (word) => {
          const key = (word + 1) * 2;
          if (this.entryFor(o).byWord.has(key)) return;
          try {
            await this.drawRaster(o, w, h, assets, key, word, false);
          } catch {
            // The overlay just draws in front when its raster is missing.
          }
        })
      )
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
    // A deleted element's picture has nothing left to draw it. Filing by id
    // means the entry outlives the element, so the document's own list is what
    // says which entries are still owed — checked only when there are more of
    // them than elements, which is the only way one can be stale.
    this.pass++;
    if (this.rasters.size > overlays.length) {
      const ids = new Set(overlays.map((o) => o.id));
      for (const [id, e] of this.rasters) {
        if (ids.has(id)) continue;
        for (const b of e.byWord.values()) b.close();
        this.rasters.delete(id);
      }
    }
    this.sweepRasters();
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
      const tLocal = Math.max(0, t - o.start);
      const ev = evalOverlayFrame(o, tLocal, W / H);
      const bmp = this.rasterFor(o, lookAt(o, tLocal, ev), W, H, assets);
      if (!bmp) continue;
      // One cached picture per element here, so a per-glyph ramp or loop runs
      // its motion over the whole box as a single letter would.
      const g = hasGlyphMotion(ev) ? glyphStateAt(ev, 0, 1) : null;
      const alphaOf = ev.opacity * (g?.alpha ?? 1);
      if (alphaOf <= 0.001) continue;
      const cx = o.x * W;
      const cy = o.y * H;
      // A blurred, streaking, darkening or tilted element poses into the
      // scratch alone and lands softened, dimmed or turned.
      const at = {
        x: ev.x * W + (ev.dx + (g?.dx ?? 0)) * scale,
        y: ev.y * H + (ev.dy + (g?.dy ?? 0)) * scale,
      };
      const target = this.fx.begin(ctx, W, H, elementLook(ev, scale, at)) as CanvasRenderingContext2D;
      target.save();
      target.globalAlpha = alphaOf;
      target.translate(at.x, at.y);
      target.rotate(((ev.rotation + (g?.rotate ?? 0)) * Math.PI) / 180);
      target.scale(ev.scale * (ev.sx ?? 1) * (g?.sx ?? 1), ev.scale * (ev.sy ?? 1) * (g?.sy ?? 1));
      target.translate(-cx, -cy);
      // A dive flies the same one picture in, under the view the other
      // renderers draw their type under.
      const focus = ev.dive && divesAt(o.anim) ? peekDiveFocus(o, W / H, cutRenderEnv(assets)) : undefined;
      if (focus) {
        const v = diveView(ev.dive!, focus, ev, o, { width: W, height: H, scale });
        target.translate(v.tx, v.ty);
        target.scale(v.s, v.s);
        target.translate(-v.fx, -v.fy);
      }
      const origin = this.origins.get(bmp);
      target.drawImage(bmp, origin?.x ?? 0, origin?.y ?? 0);
      target.restore();
      this.fx.end(ctx);
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
