"use client";

/**
 * Rendering the cut to a file, in the browser.
 *
 * The tab already knows how to draw this project — it does it sixty times a
 * second in the preview. The only things it was missing were a clock it could
 * step rather than follow, and somewhere to put the frames. This supplies both:
 * frames are pulled at exact timestamps instead of played towards, and the
 * finished picture goes into an MP4 muxer instead of onto the screen.
 *
 * Everything about what a frame looks like comes from the same two modules the
 * preview uses — `framePlan` for what is on screen at a given moment, and
 * `FrameCompositor` for turning that into pixels. Nothing here decides how the
 * cut should look. That is the point: a render is the preview, evaluated at
 * every frame instead of at whatever moment the display asked for.
 */

import {
  CanvasSource,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  MovOutputFormat,
  Mp4OutputFormat,
  Output,
  AudioBufferSource,
  Quality,
  StreamTarget,
  type AudioCodec,
  type VideoCodec,
} from "mediabunny";
import { audioFxSpans } from "./audioEffects";
import { renderMix, type MixClip, type MixItem, type MixSpec } from "./audioMix";
import { FrameCompositor, MISSING_FRAME, type Frame } from "./composite";
import { overlayPlan, trackZeroPlan } from "./framePlan";
import { frameSink, keyframeTimeAt, openMedia, videoTrackOf } from "./mediaRead";
import type { InputVideoTrack, WrappedCanvas } from "mediabunny";
import { allowance, canvasBytes, holdMemory } from "./memoryBudget";
import { getClipSpans, overlayLayers, projectDuration, spanSequence } from "./store";
import { captionStyle, cueOverlay, cueWordFrames, laneCues, laneHidden, subtitleLaneCount, trackPos } from "./subtitles";
import { applyEffectToCanvas, evalOverlayFrame, retimeOf, grainTile, isAudioEffect, isMaskAnimated, isOverlayAnimated, maskFrameAt, MATTE_FPS, matteLumaToAlpha, planAnimatedLayers, type LottieHandle, type OverlayAnim, type PaintPhase } from "@donkeycut/effects-kit";
import { backdropStill, loadBackdropStill } from "./backdropStills";
import { hasSubjectOverlays, SubjectMaskCompositor } from "./behindPass";
import { createRasterCanvas, type RasterSurface } from "./raster";
import { renderElementPng } from "./textRender";
import { assetIsSilent, behindSubjectOverlay, clipCovers, frameOf, frontSubjectOverlay, isEffectOverlay, isTextOverlay, laneOf, overlayAnimStyle, projectBackground, projectFadeSeconds, rectOf, removalActive } from "./types";
import type { ClipSpan, EffectOverlay, MediaAsset, Overlay, StickerOverlay } from "./types";
import type { ExportDoc, ExportSettings } from "./exportClient";
import { videoBitrateFor } from "./exportDelivery";

/** Audio is written at the rate and width a delivery file wants, rather than
 * the 16 kHz mono a speech model reads. */
const AUDIO_RATE = 48000;
const AUDIO_CHANNELS = 2;

/**
 * What a delivered file is made of: the codec the user chose, and nothing in
 * its place.
 *
 * The container is only half of whether a file opens. An .mp4 carrying VP9,
 * AV1, or Opus is a valid file that QuickTime, the Finder preview, and most
 * phones refuse — the user gets something they cannot play and cannot convert.
 * So there is no second codec to fall back to: a browser that cannot encode
 * the chosen one at the chosen size fails `canRenderInBrowser`, and the export
 * goes where that codec is available — the worker for a cloud project, the
 * Mac app or the cloud for a browser-resident one. ProRes has no WebCodecs
 * encoder anywhere, so it always takes that road.
 */
export function deliveryVideoCodec(settings: ExportSettings): VideoCodec | null {
  return settings.codec === "h264" ? "avc" : settings.codec === "hevc" ? "hevc" : null;
}
export function deliveryAudioCodec(settings: ExportSettings): AudioCodec {
  return settings.audioCodec === "pcm" ? "pcm-s16" : "aac";
}

/** Codecs a working clip may use — the removal bakes and the behind-speaker
 * mask, which only this app's decoders and ffmpeg ever read, and both take
 * any of these. A file that leaves the app uses `deliveryVideoCodec`. */
export const WORKING_VIDEO_CODECS: VideoCodec[] = ["avc", "hevc", "vp9", "av1"];

export interface RenderProgress {
  /** 0..1 across the whole render. */
  ratio: number;
  stage: "audio" | "video" | "finishing";
}

/** A finished render: the file, and the scratch space it occupies. */
export interface RenderedExport {
  /** The MP4, backed by origin-private disk rather than the tab's heap — it
   * streams from there into whatever reads it. */
  file: File;
  /** Delete the backing scratch file. Call once the file has been consumed. */
  discard(): Promise<void>;
}

/**
 * Where an in-tab render writes its file while it is being made.
 *
 * Origin-private disk, not memory. The encoded output is the one thing in a
 * render whose size grows with the cut — half a gigabyte for ten minutes of
 * 1080p — and holding it in the heap is what crashes a tab on a project the
 * gate otherwise allows. On disk, the tab's memory stays flat no matter how
 * big the file gets.
 */
const SCRATCH_DIR = "cut-export-scratch";

/** After this long, a scratch file can only be the leaving of a tab that died
 * mid-render — no render or upload runs for a day. */
const SCRATCH_ORPHAN_MS = 24 * 60 * 60 * 1000;

async function scratchDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(SCRATCH_DIR, { create: true });
}

/** Sweep scratch files no render can still own. Housekeeping — a failure here
 * never stops the render that triggered it. */
async function sweepScratch(dir: FileSystemDirectoryHandle): Promise<void> {
  try {
    for await (const [name, handle] of dir) {
      if (handle.kind !== "file") continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      if (Date.now() - file.lastModified > SCRATCH_ORPHAN_MS) {
        await dir.removeEntry(name).catch(() => {});
      }
    }
  } catch {
    // The sweep is best effort.
  }
}

export interface RenderOptions {
  /** Maps an asset's stored file name to a URL the reader can open. */
  resolve: (asset: MediaAsset) => string;
  onProgress?: (progress: RenderProgress) => void;
  signal?: AbortSignal;
}

/** The bitrate the choice asks for — the model in `exportDelivery`, which
 * the engine and the dialog's estimate read too. */
export function bitrateFor(settings: ExportSettings): number {
  return videoBitrateFor(settings);
}

/** The frame reader for one open video source. */
type ClipSink = ReturnType<typeof frameSink>;

/** Canvases one clip reader cycles. Small: a render draws one frame at a time
 * and never looks back, so the pool only has to keep the frame being drawn
 * clear of the frame being decoded. */
const READER_POOL = 4;
/** Readers a render keeps open when memory is not the constraint. A cut drawn
 * from more files than this reopens the ones it comes back to. */
const READERS_TUNED = 12;
/** Frames a reader may go unasked-for before it is a candidate to close. One
 * frame's own readers are never candidates, so what a join or a stack of
 * layers needs together is never taken away from the frame needing it. */
const READER_GRACE = 2;
/**
 * Canvas bytes a reader may hold for a clip read backward.
 *
 * A reversed clip asks for its frames in falling order, and a decoder only
 * runs forward: each ask on its own would decode from the keyframe below it
 * every time, most of a group of pictures per frame. So a step down decodes
 * the window of frames ending at the ask in one pass and holds it, and the
 * asks below are answered from it until it runs out. The window is as many
 * frames as this buys at the source's size, so a 4K clip holds a few and a
 * small one holds a dozen.
 */
const BACK_WINDOW_BYTES = 64 << 20;
const BACK_WINDOW_MAX = 12;
/** Canvases the reader's pools cycle, in frames: the forward pool plus the
 * backward window and the two frames a fill needs around it. */
export function readerPoolFrames(r: { backWindow: number }): number {
  return READER_POOL + (r.backWindow > 0 ? r.backWindow + 2 : 0);
}

/** A clip's source time at timeline time `t`. */
function sourceTimeAt(span: ClipSpan, t: number): number {
  return retimeOf(span.clip).srcAt(Math.max(0, t - span.start));
}

/**
 * Frames for one clip, pulled at exact timestamps.
 *
 * A video keeps its reader open across the whole render: the timestamps a
 * render asks for only ever move forward, so the decoder walks the file once
 * rather than seeking back to the start for every frame. A still decodes once
 * and is handed back for as long as its clip is on screen.
 */
export class ClipReader {
  private input: ReturnType<typeof openMedia> | null = null;
  private sink: ClipSink | null = null;
  private track: InputVideoTrack | null = null;
  private still: Frame | null = null;
  /** The source second last asked for; an ask below it is a step back. */
  private lastAt = -Infinity;
  /** The backward window: frames in rising order, on their own sink, and the
   * frame length learned from them. */
  private backSink: ClipSink | null = null;
  private backFrames: WrappedCanvas[] = [];
  private frameDt = 1 / 30;
  private opened: Promise<ClipSink | null> | null = null;
  /** Reads that failed in a row, each off a freshly rebuilt reader. Any
   * successful read clears it. */
  private failStreak = 0;
  /** Set after the first decode failure: hardware decoder sessions are a
   * finite machine resource, and a reader that lost one keeps losing while
   * the preview holds the rest — the rebuilt reader decodes in software,
   * which always opens. */
  private software = false;
  /** The frame number this reader was last asked for, for the painter's
   * between-frames eviction. */
  usedAt = 0;

  /**
   * Pixels in a frame of the source.
   *
   * The sink is opened with no size, so its canvases are the file's own — a
   * 4K clip in a 1080p render still cycles 4K canvases. Sizing the budget off
   * the render's canvas would under-count that by the ratio between them.
   */
  get sourcePixels(): number {
    return (this.asset.width ?? 1920) * (this.asset.height ?? 1080);
  }

  /** Frames the backward window holds once it is open, 0 while it is not. */
  get backWindow(): number {
    return this.backSink ? this.windowFrames : 0;
  }

  /** Frames a backward window holds at this source's size. */
  private get windowFrames(): number {
    return Math.max(2, Math.min(BACK_WINDOW_MAX, Math.floor(BACK_WINDOW_BYTES / canvasBytes(this.sourcePixels))));
  }

  constructor(
    private asset: MediaAsset,
    /** Resolved on open, and again on a re-open, so a link re-minted while the
     * render is running is picked up rather than the render dying on the
     * snapshot's expired one. */
    private url: () => string
  ) {}

  /** Open the source and hand back its frame reader, or null when it has no
   * readable picture (a still, which is served from `this.still`, or a source
   * with no decodable video). */
  private open(): Promise<ClipSink | null> {
    return (this.opened ??= (async () => {
      if (this.asset.type === "image") {
        const blob = await (await fetch(this.url())).blob();
        const bitmap = await createImageBitmap(blob);
        this.still = {
          kind: "ready",
          image: bitmap,
          width: bitmap.width,
          height: bitmap.height,
        };
        return null;
      }
      const input = openMedia(this.url());
      const track = await videoTrackOf(input);
      if (!track) {
        input.dispose();
        return null;
      }
      this.input = input;
      this.track = track;
      // A small pool keeps the render's canvas allocation flat over thousands
      // of frames.
      this.sink = frameSink(track, undefined, {
        poolSize: READER_POOL,
        ...(this.software ? { software: true } : {}),
      });
      return this.sink;
    })());
  }

  /** The clip's picture at source time `at`, or a missing frame when the
   * source has none — a still-less video, or a time past its end. A render
   * never reports `pending`: it waits for the decode instead of moving on. */
  async frameAt(at: number): Promise<Frame> {
    let sink = await this.open();
    if (this.still) return this.still;
    if (!sink) return MISSING_FRAME;
    const stepBack = at < this.lastAt - 1e-6;
    this.lastAt = at;
    for (;;) {
      try {
        const wrapped = (stepBack && (await this.backFrame(at))) || (await sink.getCanvas(Math.max(0, at)));
        this.failStreak = 0;
        if (!wrapped) return MISSING_FRAME;
        return {
          kind: "ready",
          image: wrapped.canvas,
          width: wrapped.canvas.width,
          height: wrapped.canvas.height,
        };
      } catch (err) {
        // Decoders die mid-job for reasons that pass: a signed link that
        // expired under a long render (reopening resolves the URL again), a
        // hardware decoder wedged by contention ("Decoding error."). A fresh
        // reader recovers both, so rebuild and re-read the same frame, with a
        // breath between tries for the decoder to come back. Only a source
        // that keeps failing straight off fresh decoders is truly
        // unreadable, and that stops the job.
        if (++this.failStreak > 3) throw err;
        this.software = true;
        await new Promise((r) => setTimeout(r, 250 * this.failStreak));
        this.input?.dispose();
        this.input = null;
        this.sink = null;
        this.track = null;
        this.dropBack();
        this.opened = null;
        const reopened = await this.open();
        if (!reopened) throw err;
        sink = reopened;
      }
    }
  }

  /**
   * The frame covering `at` for a reader stepping down its source, out of
   * the backward window — filled first when the window has run out: the
   * frames from the keyframe below `at` (or as many as the window holds)
   * up to `at`, decoded in one pass on the window's own sink. Null when the
   * source has no frame there, and the ordinary read answers.
   */
  private async backFrame(at: number): Promise<WrappedCanvas | null> {
    const covering = (f: WrappedCanvas) =>
      f.timestamp <= at + 1e-4 && at < f.timestamp + Math.max(f.duration, 1e-4) + 1e-4;
    const held = this.backFrames.find(covering);
    if (held) return held;
    if (!this.track) return null;
    const kt = await keyframeTimeAt(this.track, Math.max(0, at));
    if (kt === null) return null;
    const window = this.windowFrames;
    this.backSink ??= frameSink(this.track, undefined, {
      poolSize: window + 2,
      ...(this.software ? { software: true } : {}),
    });
    const start = Math.max(kt, at - (window - 1) * this.frameDt, 0);
    const frames: WrappedCanvas[] = [];
    const stream = this.backSink.canvases(start);
    try {
      for (;;) {
        const { value, done } = await stream.next();
        if (done || !value) break;
        if (value.duration > 0) this.frameDt = value.duration;
        if (value.timestamp > at + 1e-4) break;
        frames.push(value);
        if (frames.length > window) frames.shift();
        if (value.timestamp + value.duration > at + 1e-4) break;
      }
    } finally {
      void stream.return(undefined).catch(() => {});
    }
    this.backFrames = frames;
    return frames.find(covering) ?? frames[frames.length - 1] ?? null;
  }

  private dropBack(): void {
    this.backFrames = [];
    this.backSink = null;
  }

  dispose() {
    this.input?.dispose();
    this.input = null;
    this.sink = null;
    this.track = null;
    this.dropBack();
    if (this.still?.kind === "ready") (this.still.image as ImageBitmap).close?.();
    this.still = null;
  }
}

/** A text layer and the window it is on screen for. The picture is drawn when
 * the render reaches it, not up front. */
/** The effect elements live at `t`, deepest lane first — the order the stack
 * is walked in. */
function liveEffectsAt(overlays: Overlay[], t: number): EffectOverlay[] {
  return overlays
    .filter(isEffectOverlay)
    .filter((o) => !isAudioEffect(o.effect))
    .filter((o) => !o.hidden && t >= o.start && t < o.end)
    .sort((a, b) => laneOf(b) - laneOf(a));
}

/** Captions sit above every element and every effect; lane 0 is the topmost
 * element row, so they need a place above that. */
const CAPTION_LANE = -1;

interface StampedLayer {
  overlay: Overlay;
  start: number;
  end: number;
  /** Where this layer sits in the stack: the element's lane, or -1 for a
   * caption, which rides above every element and every effect. */
  stackLane: number;
  /** Animated element: drawStamps evaluates this at (t − animStart) over
   * animDur and applies the result as a canvas transform about the element
   * center. Typewriter windows are pre-sliced into per-char layers, so their
   * anim carries the remaining slots only. */
  anim?: OverlayAnim;
  animStart?: number;
  animDur?: number;
  /** The element this layer came from, before the picture was neutralized or
   * a typewriter slice trimmed its text. The per-frame pose is evaluated from
   * it, so keys and the element's own rotation/opacity survive. */
  source?: Overlay;
  /** Lottie sticker: seek this per frame instead of caching one bitmap. */
  lottie?: LottieHandle;
  /** Pixel-level animation baked into this window's picture (a wipe's
   * uncovered share, a per-glyph ramp's position). */
  phase?: PaintPhase;
}

/**
 * Text overlays and captions, each as one layer with the window it belongs to.
 *
 * Every distinct look is a layer: a plain cue is one, and a word-highlight cue
 * is one per word, since the highlight moves. What is *not* done here is
 * turning them into pictures. A full-frame RGBA bitmap is about 8 MB at 1080p,
 * and a four-minute subtitled cut has several hundred word windows — decoding
 * them all before the first frame is drawn, and holding them for the whole
 * render, exhausts the tab on projects the worker handles comfortably.
 *
 * The layout itself is the same rendering the ffmpeg path burns in, so the
 * words land in the same place whichever renderer produced the file.
 */
async function stampText(doc: ExportDoc): Promise<StampedLayer[]> {
  const duration = projectDuration(doc);
  const layers: StampedLayer[] = [];

  for (const o of doc.overlays) {
    if (o.hidden || o.start >= duration) continue;
    // A blank title has no pixels to draw; shapes and stickers always render.
    if (isTextOverlay(o) && !o.text.trim()) continue;
    // Behind-the-speaker elements composite in the subject pass, under the
    // person; front subject-masked elements stamp normally and the draw
    // trims them to the matte.
    if (behindSubjectOverlay(o)) continue;
    // Effect elements filter the video per frame; nothing to stamp.
    if (o.kind === "effect") continue;
    // A Lottie sticker seeks per frame; its handle rides the layer.
    const lottie =
      o.kind === "sticker" && o.lottie && o.assetId
        ? ((await import("./lottieAssets").then((m) =>
            m.sharedLottieHandle(o.assetId!, doc.assets)
          )) ?? undefined)
        : undefined;
    if (isOverlayAnimated(o) || lottie) {
      const before = layers.length;
      pushAnimatedLayers(layers, o, Math.min(o.end, duration));
      for (let i = before; i < layers.length; i++) {
        layers[i].stackLane = laneOf(o);
        if (lottie) layers[i].lottie = lottie;
      }
      continue;
    }
    layers.push({
      overlay: o,
      start: o.start,
      end: Math.min(o.end, duration),
      stackLane: laneOf(o),
    });
  }

  if (doc.subtitles.showOnVideo) {
    const capStyle = captionStyle(doc.subtitles.style);
    // Wrap in design space (1080 short side) from the project ratio — the same
    // width the preview passes, whatever the render size.
    const designWidth = frameOf(doc.aspect).w;
    for (let lane = 0; lane < subtitleLaneCount(doc.subtitles); lane++) {
      if (laneHidden(doc.subtitles, lane)) continue;
      const cues = laneCues(doc.subtitles, lane);
      const pos = trackPos(doc.subtitles, capStyle, lane);
      for (let i = 0; i < cues.length; i++) {
        const cue = cues[i];
        if (cue.start >= duration || !cue.text.trim()) continue;
        const windows = doc.subtitles.wordHighlight
          ? cueWordFrames(cue, capStyle, doc.subtitles)
          : [{ start: cue.start, end: cue.end }];
        for (let wi = 0; wi < windows.length; wi++) {
          const win = windows[wi];
          if (win.start >= duration) break;
          layers.push({
            overlay: cueOverlay(
              cue,
              capStyle,
              i === 0,
              pos,
              doc.subtitles.wordHighlight ? (win.start + win.end) / 2 : undefined,
              designWidth
            ),
            start: win.start,
            end: Math.min(win.end, duration),
            stackLane: CAPTION_LANE,
          });
        }
      }
    }
  }
  return layers;
}

/**
 * Text layer pictures, drawn on demand and released once their window passes.
 *
 * A render walks time forwards, so only the layers live at the current moment
 * are needed — usually a caption and maybe a title. Holding those and dropping
 * the rest keeps the memory a subtitled export uses flat in the length of the
 * cut instead of growing with every word in it.
 */
class StampCache {
  private drawn = new Map<StampedLayer, ImageBitmap>();
  private maskFrames = new Map<StampedLayer, { t: number; bitmap: ImageBitmap }>();

  constructor(
    private width: number,
    private height: number,
    private assets: MediaAsset[]
  ) {}

  async bitmapFor(layer: StampedLayer): Promise<ImageBitmap> {
    let bitmap = this.drawn.get(layer);
    if (!bitmap) {
      const png = await renderElementPng(
        layer.overlay,
        this.width,
        this.height,
        this.assets,
        layer.phase
      );
      bitmap = await createImageBitmap(png);
      this.drawn.set(layer, bitmap);
    }
    return bitmap;
  }

  /** The layer's picture drawn for this one moment, for the animations that
   * change the pixels as time moves — a keyframed mask, a per-glyph loop.
   * There is one live bitmap per layer, replaced as the render walks forward:
   * the cached-stamp twin of the Lottie per-frame path. */
  async bitmapAt(layer: StampedLayer, tLocal: number, phase?: PaintPhase): Promise<ImageBitmap> {
    const hit = this.maskFrames.get(layer);
    if (hit && Math.abs(hit.t - tLocal) < 1e-6) return hit.bitmap;
    const m = layer.overlay.mask;
    const el = isMaskAnimated(m)
      ? { ...layer.overlay, mask: { ...m!, ...maskFrameAt(m!, tLocal), kf: undefined } }
      : layer.overlay;
    const png = await renderElementPng(el, this.width, this.height, this.assets, phase);
    const bitmap = await createImageBitmap(png);
    hit?.bitmap.close();
    this.maskFrames.set(layer, { t: tLocal, bitmap });
    return bitmap;
  }

  /** Release the pictures of layers that have finished by `t`. */
  retire(t: number) {
    for (const [layer, bitmap] of this.drawn) {
      if (layer.end <= t) {
        bitmap.close();
        this.drawn.delete(layer);
      }
    }
    for (const [layer, hit] of this.maskFrames) {
      if (layer.end <= t) {
        hit.bitmap.close();
        this.maskFrames.delete(layer);
      }
    }
  }

  dispose() {
    for (const bitmap of this.drawn.values()) bitmap.close();
    this.drawn.clear();
    for (const hit of this.maskFrames.values()) hit.bitmap.close();
    this.maskFrames.clear();
  }
}

/** Head and tail audio ramps for one upper-track clip: its own entrance/exit
 * animation, or the transition that owns that edge. Mirrors the ramps the
 * export spec carries and the gain the preview applies, so a picture that
 * fades up takes its sound with it. */
function overlayRamps(
  spans: ClipSpan[]
): { head: number; tail: number; crossIn: number; crossOut: number }[] {
  const ramps = spans.map(() => ({ head: 0, tail: 0, crossIn: 0, crossOut: 0 }));
  spans.forEach((sp, i) => {
    const apply = (anim: typeof sp.clip.animIn, side: "head" | "tail") => {
      if (!anim) return;
      // A zoom does not change how loud a clip is; every other style ramps.
      if (overlayAnimStyle(anim.style) === "zoom") return;
      ramps[i][side] = Math.max(ramps[i][side], Math.min(anim.seconds, sp.len));
    };
    // A transitioned joint owns its edge, so the animation there stands down.
    if (!((spans[i - 1]?.transitionOut ?? 0) > 0)) apply(sp.clip.animIn, "head");
    if (!(sp.transitionOut > 0)) apply(sp.clip.animOut, "tail");
    if (sp.transitionOut > 0 && spans[i + 1]) {
      ramps[i].tail = Math.max(ramps[i].tail, sp.transitionOut);
      ramps[i + 1].head = Math.max(ramps[i + 1].head, sp.transitionOut);
    }
    // A cross dissolve is these ramps and nothing else: the picture cuts.
    // They stay off `head`/`tail` — a fade ends at silence, a crossing ramps
    // equal-power past the clip on the other side of the cut.
    if (sp.soundOut > 0 && spans[i + 1]) {
      ramps[i].crossOut = sp.soundOut;
      ramps[i + 1].crossIn = sp.soundOut;
    }
  });
  return ramps;
}

/**
 * The mix spec for a doc: track-0 clip audio in sequence, plus everything
 * placed at an absolute time — the soundtrack and every upper-track clip's own
 * sound, which the preview plays and the file therefore has to carry.
 *
 * The track-0 fold is sequential, so gaps between free-placed clips have to
 * ship as explicit silent spacers. Without them the audio closes up the gaps
 * while the picture keeps them, and everything after the first gap plays early.
 */
export function mixSpecFor(doc: ExportDoc, resolve: (asset: MediaAsset) => string): MixSpec {
  const duration = projectDuration(doc);
  const spans = getClipSpans(doc.clips, doc.assets, 0);
  const byId = new Map(doc.assets.map((a) => [a.id, a]));
  const items: MixItem[] = [];
  for (const track of new Set(overlayLayers(doc.clips).map((c) => c.track))) {
    const trackSpans = getClipSpans(doc.clips, doc.assets, track);
    const ramps = overlayRamps(trackSpans);
    trackSpans.forEach((sp, i) => {
      if (sp.clip.hidden || sp.start >= duration) return;
      items.push({
        file: resolve(sp.asset),
        in: sp.clip.in,
        out: sp.clip.out,
        start: sp.start,
        volume: sp.clip.volume ?? 1,
        speed: sp.clip.speed,
        speedCurve: sp.clip.speedCurve,
        reverse: sp.clip.reverse,
        sound: sp.clip.sound,
        muted: sp.clip.muted || assetIsSilent(sp.asset),
        fadeIn: ramps[i].head,
        fadeOut: ramps[i].tail,
        crossIn: ramps[i].crossIn,
        crossOut: ramps[i].crossOut,
        soundBack: sp.soundBack,
        soundAhead: sp.soundAhead,
      });
    });
  }
  for (const a of doc.audioClips) {
    const asset = byId.get(a.assetId);
    if (!asset || a.hidden || a.start >= duration || assetIsSilent(asset)) continue;
    items.push({
      file: resolve(asset),
      in: a.in,
      out: a.out,
      start: a.start,
      volume: a.volume,
      speed: a.speed,
      speedCurve: a.speedCurve,
      reverse: a.reverse,
      fadeIn: a.fadeIn,
      fadeOut: a.fadeOut,
      sound: a.sound,
      duck: a.duck,
    });
  }

  const spacer = (len: number): MixClip => ({ file: "", in: 0, out: len, muted: true });
  const clips: MixClip[] =
    spans.length === 0
      ? [spacer(duration)]
      : spanSequence(spans).flatMap(({ gapBefore, span: sp }) => [
          ...(gapBefore > 0 ? [spacer(gapBefore)] : []),
          {
            file: resolve(sp.asset),
            in: sp.clip.in,
            out: sp.clip.out,
            muted: sp.clip.muted || !!sp.clip.hidden || assetIsSilent(sp.asset),
            speed: sp.clip.speed,
            speedCurve: sp.clip.speedCurve,
            reverse: sp.clip.reverse,
            volume: sp.clip.volume,
            sound: sp.clip.sound,
            transition: sp.transitionOut,
            soundCross: sp.soundOut,
            soundBack: sp.soundBack,
            soundAhead: sp.soundAhead,
          },
        ]);

  return {
    duration,
    clips,
    items,
    // Audio effect elements treat the finished mix over their own windows.
    effects: audioFxSpans(doc.overlays, duration),
    fadeIn: projectFadeSeconds(doc.fadeIn, duration),
    fadeOut: projectFadeSeconds(doc.fadeOut, duration),
  };
}

/** Whether a mix spec has anything audible in it — the same test the mixer
 * uses to decide which spans it decodes. */
export function mixHasSound(spec: MixSpec): boolean {
  return spec.clips.some((c) => c.file && !c.muted) || spec.items.some((i) => !i.muted);
}

/** Whole-video fade gain at `t`, the picture's side of the project fade. */
function projectFadeGain(doc: ExportDoc, t: number, total: number): number {
  const fadeIn = projectFadeSeconds(doc.fadeIn, total);
  const fadeOut = projectFadeSeconds(doc.fadeOut, total);
  let g = 1;
  if (fadeIn > 0 && t < fadeIn) g = Math.min(g, Math.max(0, t / fadeIn));
  if (fadeOut > 0 && t > total - fadeOut) g = Math.min(g, Math.max(0, (total - t) / fadeOut));
  return Math.min(1, g);
}

/**
 * Render `doc` to an MP4 in scratch storage.
 *
 * Frames are produced in order and handed to the muxer as they are drawn, so
 * the memory this holds is a handful of decoded frames rather than the render.
 * The encoded output goes the same way: the muxer writes each chunk to the
 * scratch file and lets it go, so the file on disk is the only whole copy that
 * ever exists. The audio is mixed up front, because a single offline pass over
 * the whole timeline is both cheaper and more accurate than trying to mix it
 * in slices that have to agree at the seams.
 *
 * The file carries its index at the front, like the ffmpeg path's faststart
 * files. That placement normally costs either memory (buffer everything) or a
 * second pass (ffmpeg's), but a render knows its exact frame and sample counts
 * before it starts, which is enough for the muxer to reserve the index's space
 * up front and fill it in at the end.
 */
export async function renderProjectToMp4(
  doc: ExportDoc,
  settings: ExportSettings,
  opts: RenderOptions
): Promise<RenderedExport> {
  const { resolve, onProgress, signal } = opts;
  const duration = projectDuration(doc);
  if (!(duration > 0)) throw new Error("There is nothing to export yet.");

  const wanted = deliveryVideoCodec(settings);
  if (!wanted) throw new Error("This browser can't encode ProRes.");
  const codec = await getFirstEncodableVideoCodec([wanted], {
    width: settings.width,
    height: settings.height,
  });
  if (!codec) {
    throw new Error(
      `This browser can't encode ${settings.codec === "hevc" ? "HEVC" : "H.264"} at ${settings.width} × ${settings.height}.`
    );
  }

  const stop = () => {
    if (signal?.aborted) throw new DOMException("Export canceled.", "AbortError");
  };

  onProgress?.({ ratio: 0, stage: "audio" });
  const mix = await renderMix(mixSpecFor(doc, resolve), {
    sampleRate: AUDIO_RATE,
    channels: AUDIO_CHANNELS,
    resolve: (file) => file, // mixSpecFor already resolved each asset to a URL
  });
  stop();

  const canvas = createRasterCanvas(settings.width, settings.height);
  const painter = new FramePainter(doc, canvas, resolve);

  const frameDur = 1 / settings.fps;
  const frames = Math.max(1, Math.round(duration * settings.fps));

  const dir = await scratchDir();
  void sweepScratch(dir);
  const scratchName = `export-${crypto.randomUUID()}.mp4`;
  const scratchHandle = await dir.getFileHandle(scratchName, { create: true });
  const writable = await scratchHandle.createWritable();
  const discard = async () => {
    // An open writer holds a lock removeEntry respects; closing is a no-op
    // once the muxer already has.
    await writable.close().catch(() => {});
    await dir.removeEntry(scratchName).catch(() => {});
  };

  const output = new Output({
    format:
      settings.container === "mov"
        ? new MovOutputFormat({ fastStart: "reserve" })
        : new Mp4OutputFormat({ fastStart: "reserve" }),
    target: new StreamTarget(writable, { chunked: true }),
  });

  try {
    const video = new CanvasSource(canvas, {
      codec,
      quality: new Quality({ bitrate: bitrateFor(settings) }),
    });
    // Reserving the index space needs a packet ceiling per track. The video's
    // is exact — one packet per frame; the audio's is the mix's sample count
    // over a floor below the samples a packet carries (AAC packs 1024, the
    // muxer's own PCM 2048), plus slack for encoder priming. Over-reserving
    // costs a few bytes of index; under-reserving fails the finalize.
    output.addVideoTrack(video, { frameRate: settings.fps, maximumPacketCount: frames + 8 });
    let audio: AudioBufferSource | null = null;
    if (mix) {
      // PCM is packed by the muxer itself; AAC needs the browser's encoder,
      // and a cut with sound keeps it: an Opus stand-in plays nowhere the
      // user is taking the file, so a browser without AAC hands the render on.
      const audioCodec = await getFirstEncodableAudioCodec([deliveryAudioCodec(settings)], {
        numberOfChannels: AUDIO_CHANNELS,
        sampleRate: AUDIO_RATE,
      });
      if (!audioCodec) throw new Error("This browser can't encode AAC audio.");
      audio = new AudioBufferSource({
        codec: audioCodec,
        ...(audioCodec === "aac" ? { quality: new Quality({ bitrate: 192_000 }) } : {}),
      });
      output.addAudioTrack(audio, { maximumPacketCount: Math.ceil(mix.length / 960) + 32 });
    }
    await output.start();

    // The audio is one buffer for the whole timeline, so it goes in before the
    // frames rather than being interleaved with them.
    if (audio && mix) await audio.add(mix);

    await painter.prepare();
    stop();

    for (let i = 0; i < frames; i++) {
      stop();
      const t = i * frameDur;
      await painter.drawAt(t);

      await video.add(t, frameDur);
      if (i % 15 === 0) {
        onProgress?.({ ratio: i / frames, stage: "video" });
        // Let the tab breathe: without a yield a long render starves every
        // other task on this thread, including the one listening for a cancel.
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    onProgress?.({ ratio: 1, stage: "finishing" });
    // Finalize fills in the reserved index and closes the scratch file, so the
    // handle reads back the finished MP4.
    await output.finalize();
    return { file: await scratchHandle.getFile(), discard };
  } catch (err) {
    await output.cancel().catch(() => {});
    await discard();
    throw err;
  } finally {
    painter.dispose();
  }
}

/** Draw the text layers live at `t` over the finished picture. */
/** Stamped layers for one animated element: the kit plans the windows (the
 * same split its frame sequences use), and the render hangs what only it knows
 * on them — the element they came from, and a Lottie handle to seek. */
function pushAnimatedLayers(layers: StampedLayer[], o: Overlay, end: number) {
  const shared = {
    animStart: o.start,
    animDur: Math.max(0.1, o.end - o.start),
    source: o,
    stackLane: laneOf(o),
  };
  for (const layer of planAnimatedLayers(o, end)) layers.push({ ...layer, ...shared });
}

async function drawStamps(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  layers: StampedLayer[],
  stamps: StampCache,
  t: number,
  subject?: SubjectMaskCompositor | null
) {
  const ctx = canvas.getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) return;
  for (const layer of layers) {
    if (t < layer.start || t >= layer.end) continue;
    if (layer.lottie) {
      // Nothing to cache: the animation's own canvas is sought per frame and
      // drawn at the sticker's rect under the same delta transform.
      const o = layer.overlay as StickerOverlay;
      const ev = evalOverlayFrame(
        { ...(layer.source ?? o), anim: layer.anim },
        t - (layer.animStart ?? layer.start)
      );
      if (ev.opacity <= 0.001) continue;
      const scale = Math.min(canvas.width, canvas.height) / 1080;
      const w = Math.max(1, o.w * canvas.width);
      const aspect = layer.lottie.width > 0 ? layer.lottie.width / layer.lottie.height : 1;
      const h = w / aspect;
      ctx.save();
      ctx.globalAlpha = ev.opacity;
      ctx.translate(ev.x * canvas.width + ev.dx * scale, ev.y * canvas.height + ev.dy * scale);
      ctx.rotate((ev.rotation * Math.PI) / 180);
      ctx.scale(ev.scale, ev.scale);
      ctx.drawImage(layer.lottie.seek(t - (layer.animStart ?? layer.start)), -w / 2, -h / 2, w, h);
      ctx.restore();
      continue;
    }
    // Unkeyed, the bitmap bakes the element's own rotation/opacity and only
    // the preset's delta composes on top. Keyed, the bitmap is neutral and the
    // pose supplies position, scale, rotation and opacity outright — either
    // way this samples the evaluator the ffmpeg path rasterized into frames.
    const tLocal = t - (layer.animStart ?? layer.start);
    const ev = layer.anim
      ? evalOverlayFrame({ ...(layer.source ?? layer.overlay), anim: layer.anim }, tLocal)
      : null;
    // A per-glyph loop moves the characters inside the picture, so its window
    // is drawn afresh each frame with the loop folded into the layer's phase.
    const livePhase = ev?.glyphLoop ? { ...layer.phase, glyphLoop: ev.glyphLoop } : undefined;
    const bitmap =
      livePhase || isMaskAnimated(layer.overlay.mask)
        ? await stamps.bitmapAt(layer, tLocal, livePhase ?? layer.phase)
        : await stamps.bitmapFor(layer);
    // A front subject-masked stamp trims to the pass's current matte — its
    // pixels change with the video, so the trim happens at draw time, never
    // in the cached raster.
    const subjectFront = !!subject && frontSubjectOverlay(layer.overlay);
    if (!ev) {
      const picture = subjectFront
        ? subject!.mattedStamp(layer.overlay, canvas.width, canvas.height, (c) =>
            c.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
          )
        : bitmap;
      ctx.drawImage(picture, 0, 0, canvas.width, canvas.height);
      continue;
    }
    if (ev.opacity <= 0.001) continue;
    const scale = Math.min(canvas.width, canvas.height) / 1080;
    const cx = layer.overlay.x * canvas.width;
    const cy = layer.overlay.y * canvas.height;
    const posed = (c: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => {
      c.translate(ev.x * canvas.width + ev.dx * scale, ev.y * canvas.height + ev.dy * scale);
      c.rotate((ev.rotation * Math.PI) / 180);
      c.scale(ev.scale, ev.scale);
      c.translate(-cx, -cy);
      c.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    };
    ctx.save();
    ctx.globalAlpha = ev.opacity;
    if (subjectFront) {
      // Pose the stamp inside the matte surface, so the matte stays put in
      // frame space while the element travels beneath it.
      ctx.drawImage(
        subject!.mattedStamp(layer.overlay, canvas.width, canvas.height, posed),
        0,
        0
      );
    } else {
      posed(ctx);
    }
    ctx.restore();
  }
}

/**
 * The cut's picture, drawn at whatever moment is asked for.
 *
 * Everything a frame needs that outlives the frame lives here: the
 * compositor, the open decoders, the stamped text layers, the subject pass.
 * A render walks it forward frame by frame; a single capture opens it, draws
 * once, and lets it go. Both get the same picture, because it is the same
 * code drawing it.
 */
export class FramePainter {
  private comp: FrameCompositor;
  private stamps: StampCache;
  private readers = new Map<string, ClipReader>();
  /** What the open readers are standing on, so a render in the tab shows up
   * beside the preview's own pictures in the memory report. */
  private readonly releaseMemory = holdMemory("exportReaders", () => {
    let n = 0;
    for (const r of this.readers.values()) n += canvasBytes(readerPoolFrames(r) * r.sourcePixels);
    return n;
  });
  /** Frames drawn, which is the clock the readers' eviction order runs on. */
  private frameNo = 0;
  private behind: SubjectMaskCompositor | null = null;
  private fxScratch: RasterSurface | null = null;
  /** This frame's removal mattes, one alpha image per keyed clip — fetched
   * with the layer frames (readers are async) and read synchronously by the
   * compositor's provider mid-draw. */
  private matteFrames = new Map<string, CanvasImageSource>();
  /** Per-clip conversion scratch for those mattes (luma frame → alpha). */
  private matteScratch = new Map<string, RasterSurface>();
  /** Which matte frame each scratch currently holds, so the luma → alpha
   * pixel pass runs once per matte frame. */
  private matteStamp = new Map<string, string>();
  /** Text layers, deepest lane first — so a walk of them is a walk up the stack. */
  private stacked: StampedLayer[] = [];
  private spans: ClipSpan[] = [];
  private overlayTracks: number[] = [];
  private byTrack = new Map<number, ClipSpan[]>();
  private spanOfClip = new Map<string, ClipSpan>();
  private duration: number;

  constructor(
    private doc: ExportDoc,
    private canvas: RasterSurface,
    private resolve: (asset: MediaAsset) => string
  ) {
    this.comp = new FrameCompositor(canvas);
    this.comp.background = projectBackground(doc.background);
    this.stamps = new StampCache(canvas.width, canvas.height, doc.assets);
    this.duration = projectDuration(doc);
  }

  /** Make the text layers, the span geometry and the subject pass resident.
   * Runs once, before the first frame. */
  async prepare(): Promise<void> {
    this.stacked = [...(await stampText(this.doc))].sort((a, b) => b.stackLane - a.stackLane);
    // The subject pass is created only when something reads the person matte;
    // prepare() makes rasters and the segmenter resident before the first
    // frame. Subject-masked clips pull their matte mid-stack through the
    // compositor's provider, per frame (no throttling in an export).
    if (
      hasSubjectOverlays(this.doc.overlays) ||
      this.doc.clips.some((c) => c.mask?.kind === "subject")
    ) {
      const behind = new SubjectMaskCompositor();
      await behind.prepare(
        this.doc.overlays,
        this.canvas.width,
        this.canvas.height,
        this.doc.assets
      );
      this.behind = behind;
      this.comp.subjectMatteProvider = (at) =>
        behind.clipMatteOf(this.canvas, at, { minMaskInterval: 0 });
    }
    // Removal: baked mattes are prefetched per frame into `matteFrames`; the
    // provider is a synchronous read of that map. Backdrop stills decode once
    // here, so mid-render reads are cache hits.
    this.comp.removalMatteProvider = (clip) => this.matteFrames.get(clip.id) ?? null;
    this.comp.backdropImageProvider = (assetId) => backdropStill(this.doc.assets, assetId);
    const backdropIds = new Set(
      this.doc.clips
        .map((c) => c.removal?.backdrop)
        .filter((b) => b?.kind === "image" && b.assetId)
        .map((b) => b!.assetId!)
    );
    await Promise.all(
      [...backdropIds].map((id) => {
        const asset = this.doc.assets.find((a) => a.id === id);
        return asset ? loadBackdropStill({ ...asset, url: this.resolve(asset) }) : null;
      })
    );
    // Span geometry is a property of the document, which does not change while
    // rendering — so it is computed once rather than per overlay per frame.
    this.spans = getClipSpans(this.doc.clips, this.doc.assets, 0);
    this.overlayTracks = [...new Set(overlayLayers(this.doc.clips).map((c) => c.track))];
    this.byTrack = new Map(
      this.overlayTracks.map((track) => [track, getClipSpans(this.doc.clips, this.doc.assets, track)])
    );
    for (const list of this.byTrack.values())
      for (const sp of list) this.spanOfClip.set(sp.clip.id, sp);
  }

  /**
   * The reader for one asset, opening it if this frame is the first to ask.
   *
   * Readers are kept between frames because a render walks time forward and
   * asks the same clip for thousands of consecutive frames; reopening one per
   * frame would pay a keyframe seek for every one of them. They are not kept
   * forever: each holds a decoder and a pool of canvases at the render size, so
   * a cut drawing from a hundred files would otherwise finish the render
   * holding a hundred decoders. Past the budget the least recently drawn are
   * let go, which costs one reopen if the cut returns to them.
   */
  private readerFor(asset: MediaAsset): ClipReader {
    let r = this.readers.get(asset.id);
    if (!r) this.readers.set(asset.id, (r = new ClipReader(asset, () => this.resolve(asset))));
    r.usedAt = this.frameNo;
    return r;
  }

  /**
   * Close the readers this cut has moved on from.
   *
   * Readers are kept between frames because a render walks time forward and
   * asks the same clip for thousands of consecutive frames; reopening one per
   * frame would pay a keyframe seek for every one. They are not kept forever:
   * each holds a decoder and a pool of canvases at the *source's* own size, so
   * a cut drawing from a hundred files would otherwise end the render holding a
   * hundred decoders.
   *
   * This runs between frames, before anything has been asked for, and spares
   * everything the last couple of frames used. A frame reaches for several
   * readers at once — a join's two sides, a backdrop, a matte, every overlay
   * layer — and closing one the frame is midway through would leave the
   * compositor drawing from a disposed decoder. Closing them here, past the
   * grace, cannot.
   */
  private evictReaders(): void {
    const cost = (r: ClipReader) => canvasBytes(readerPoolFrames(r) * r.sourcePixels);
    const cap = allowance(
      "exportReaders",
      READERS_TUNED * canvasBytes(READER_POOL * 1920 * 1080)
    );
    let held = 0;
    for (const r of this.readers.values()) held += cost(r);
    if (held <= cap) return;
    const old = [...this.readers.entries()]
      .filter(([, r]) => this.frameNo - r.usedAt > READER_GRACE)
      .sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [id, r] of old) {
      if (held <= cap) break;
      held -= cost(r);
      this.readers.delete(id);
      r.dispose();
    }
  }

  /** Pull a removal clip's baked matte frame for timeline time `t` and stage
   * it, luma turned to alpha, where the compositor's provider reads. A clip
   * whose bake is still owed stages nothing. */
  private async fetchRemovalMatte(span: ClipSpan, t: number): Promise<void> {
    const clip = span.clip;
    const m = removalActive(clip.removal) ? clip.removal?.matte : undefined;
    this.matteFrames.delete(clip.id);
    if (!m) return;
    const asset = this.doc.assets.find((a) => a.id === m.assetId);
    if (!asset) return;
    const dur = Math.max(0.001, asset.duration);
    const mt = Math.max(0, Math.min(sourceTimeAt(span, t) - m.in, dur - 0.001));
    const frame = await this.readerFor(asset).frameAt(mt);
    if (frame.kind !== "ready") return;
    let scratch = this.matteScratch.get(clip.id);
    // The matte advances at its own baked rate below the export's, so a
    // converted frame is reused until the read crosses into the next one —
    // the pixel pass is per matte frame, never per output frame.
    const stamp = `${m.assetId}:${Math.floor(mt * MATTE_FPS)}`;
    if (scratch && this.matteStamp.get(clip.id) === stamp) {
      this.matteFrames.set(clip.id, scratch as CanvasImageSource);
      return;
    }
    if (!scratch) this.matteScratch.set(clip.id, (scratch = createRasterCanvas(frame.width, frame.height)));
    if (scratch.width !== frame.width) scratch.width = frame.width;
    if (scratch.height !== frame.height) scratch.height = frame.height;
    const ctx = scratch.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) return;
    ctx.clearRect(0, 0, scratch.width, scratch.height);
    ctx.drawImage(frame.image, 0, 0, scratch.width, scratch.height);
    const img = ctx.getImageData(0, 0, scratch.width, scratch.height);
    matteLumaToAlpha(img.data);
    ctx.putImageData(img, 0, 0);
    this.matteStamp.set(clip.id, stamp);
    this.matteFrames.set(clip.id, scratch as CanvasImageSource);
  }

  /** Draw the whole cut at timeline time `t` onto the canvas. */
  async drawAt(t: number): Promise<void> {
    this.frameNo++;
    this.evictReaders();
    const { canvas, comp, doc, stamps } = this;
    const W = canvas.width;
    const H = canvas.height;
    comp.clear();

    const master = this.spans.find((sp) => t >= sp.start && t < sp.start + sp.len);
    if (master) {
      const plan = trackZeroPlan(master, this.spans, t);
      await this.fetchRemovalMatte(master, t);
      if (plan.incoming) await this.fetchRemovalMatte(plan.incoming, t);
      if (plan.backdrop) {
        await this.fetchRemovalMatte(plan.backdrop.span, t);
        const frame = await this.readerFor(plan.backdrop.span.asset).frameAt(plan.backdrop.at);
        comp.drawLayer(frame, plan.backdrop.span.clip, false, 1, t);
      }
      const masterFrame = master.clip.hidden
        ? MISSING_FRAME
        : await this.readerFor(master.asset).frameAt(sourceTimeAt(master, t));
      const incFrame = plan.incoming
        ? await this.readerFor(plan.incoming.asset).frameAt(sourceTimeAt(plan.incoming, t))
        : MISSING_FRAME;
      comp.drawCrossJoin(
        plan.style,
        plan.p,
        {
          masterFrame,
          masterClip: master.clip,
          masterAlpha: plan.masterAlpha,
          masterZoom: plan.masterZoom,
          masterFx: {
            dx: plan.masterFxFrac.dx * W,
            dy: plan.masterFxFrac.dy * H,
          },
          incFrame,
          incClip: plan.incoming?.clip,
          incAlpha: plan.incAlpha,
          incZoom: plan.incZoom,
        },
        t
      );
      if (plan.veil > 0) comp.fillBlackVeil(plan.veil, rectOf(master.clip));
    }

    const spansOf = (track: number) => this.byTrack.get(track) ?? [];
    for (const layer of overlayPlan(this.overlayTracks, spansOf, t)) {
      const span = this.spanOfClip.get(layer.clip.id);
      if (!span) continue;
      await this.fetchRemovalMatte(span, t);
      const frame = await this.readerFor(layer.asset).frameAt(sourceTimeAt(span, t));
      comp.drawIntoRect(
        frame,
        rectOf(layer.clip),
        clipCovers(layer.clip),
        layer.alpha,
        t,
        layer.zoom,
        layer.clip
      );
    }

    // The subject pass: video → behind elements → segmented person, exactly
    // the preview's pass, sampled per drawn frame (no mask throttling).
    // It also refreshes the matte the front subject-masked stamps read.
    this.behind?.draw(canvas, doc.overlays, doc.assets, t, { minMaskInterval: 0 });

    // The stack, bottom up: an effect grades what plays under it, so the
    // elements below it burn in first, the effect runs over that much of the
    // frame, and the elements above it land on the graded picture. Same
    // order as the live preview and the ffmpeg graph.
    let drawn = 0;
    for (const o of liveEffectsAt(doc.overlays, t)) {
      const upto = this.stacked.findIndex((l) => l.stackLane <= laneOf(o));
      const end = upto < 0 ? this.stacked.length : upto;
      if (end > drawn) await drawStamps(canvas, this.stacked.slice(drawn, end), stamps, t, this.behind);
      drawn = Math.max(drawn, end);
      this.fxScratch ??= createRasterCanvas(W, H);
      applyEffectToCanvas(
        canvas,
        this.fxScratch,
        o.effect,
        o.amount,
        t - o.start,
        grainTile,
        o.focus,
        o.ramp,
        o.end - o.start
      );
    }
    await drawStamps(canvas, this.stacked.slice(drawn), stamps, t, this.behind);
    stamps.retire(t);
    comp.drawProjectFade(projectFadeGain(doc, t, this.duration));
  }

  dispose(): void {
    this.stamps.dispose();
    this.behind?.dispose();
    for (const r of this.readers.values()) r.dispose();
    this.readers.clear();
    this.releaseMemory();
  }
}

/**
 * One composited frame of the cut, drawn the way a render of it would draw —
 * clips, transitions, effects, elements, captions, the project fade. The
 * canvas comes off the raster seam, so this answers on a page and in a job.
 */
export async function renderProjectFrame(
  doc: ExportDoc,
  at: number,
  size: { width: number; height: number },
  resolve: (asset: MediaAsset) => string
): Promise<RasterSurface> {
  const canvas = createRasterCanvas(size.width, size.height);
  const painter = new FramePainter(doc, canvas, resolve);
  try {
    await painter.prepare();
    await painter.drawAt(at);
  } finally {
    painter.dispose();
  }
  return canvas;
}

/**
 * Whether this browser can render the export at all. Two facts decide it,
 * both about the browser: it has to offer scratch storage, because the render
 * writes its file to origin-private disk, and WebCodecs has to offer a video
 * encoder at these dimensions. A cut of any length renders in the tab — the
 * pipeline streams to disk, so duration costs time, and the answer here has
 * to be known up front because a cloud project whose browser can't carry the
 * render quietly renders on the worker instead.
 */
export async function canRenderInBrowser(
  doc: ExportDoc,
  settings: ExportSettings
): Promise<boolean> {
  const duration = projectDuration(doc);
  if (!(duration > 0)) return false;
  if (
    typeof navigator.storage?.getDirectory !== "function" ||
    typeof FileSystemFileHandle === "undefined" ||
    !("createWritable" in FileSystemFileHandle.prototype)
  ) {
    return false;
  }
  try {
    const wanted = deliveryVideoCodec(settings);
    if (!wanted) return false;
    const video = await getFirstEncodableVideoCodec([wanted], {
      width: settings.width,
      height: settings.height,
    });
    if (!video) return false;
    // A cut with sound needs the audio half of the file too; a browser with
    // no AAC encoder would otherwise render the whole thing and fail at the
    // muxer, or hand back a video whose sound went missing.
    if (!mixHasSound(mixSpecFor(doc, (a) => a.url))) return true;
    return !!(await getFirstEncodableAudioCodec([deliveryAudioCodec(settings)], {
      numberOfChannels: AUDIO_CHANNELS,
      sampleRate: AUDIO_RATE,
    }));
  } catch {
    return false;
  }
}
