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
  Mp4OutputFormat,
  Output,
  AudioBufferSource,
  Quality,
  StreamTarget,
  type VideoCodec,
} from "mediabunny";
import { renderMix, type MixClip, type MixItem, type MixSpec } from "./audioMix";
import { FrameCompositor, MISSING_FRAME, type Frame } from "./composite";
import { overlayPlan, trackZeroPlan } from "./framePlan";
import { frameSink, openMedia, videoTrackOf } from "./mediaRead";
import { getClipSpans, overlayLayers, projectDuration, spanSequence } from "./store";
import { captionStyle, cueOverlay, cueWordWindows, laneCues, laneHidden, subtitleLaneCount, trackPos } from "./subtitles";
import { applyEffectToCanvas, evalOverlayFrame, grainTile, isMaskAnimated, isOverlayAnimated, maskFrameAt, planAnimatedLayers, type LottieHandle, type OverlayAnim, type PaintPhase } from "@donkeycut/effects-kit";
import { hasSubjectOverlays, SubjectMaskCompositor } from "./behindPass";
import { createRasterCanvas, type RasterSurface } from "./raster";
import { renderElementPng } from "./textRender";
import { behindSubjectOverlay, clipCovers, frameOf, frontSubjectOverlay, isEffectOverlay, isTextOverlay, laneOf, overlayAnimStyle, projectBackground, projectFadeSeconds, rectOf } from "./types";
import type { ClipSpan, EffectOverlay, MediaAsset, Overlay, StickerOverlay } from "./types";
import type { ExportDoc, ExportSettings } from "./exportClient";

/** Audio is written at the rate and width a delivery file wants, rather than
 * the 16 kHz mono a speech model reads. */
const AUDIO_RATE = 48000;
const AUDIO_CHANNELS = 2;

/** Video codecs to try, best first. */
export const VIDEO_CODECS: VideoCodec[] = ["avc", "hevc", "vp9", "av1"];

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

/**
 * The bitrate a preset's CRF asks for, in bits per second.
 *
 * WebCodecs encodes to a bitrate; the presets are written in CRF, which is a
 * quality target the encoder spends whatever it needs to hit. The conversion
 * is the same bits-per-pixel model the export dialog already estimates sizes
 * with, so a preset keeps meaning roughly what it meant.
 */
export function bitrateFor(settings: ExportSettings): number {
  const pixelsPerSec = settings.width * settings.height * settings.fps;
  const bpp = 0.08 * 2 ** ((23 - settings.crf) / 6);
  return Math.round(pixelsPerSec * bpp);
}

/** The frame reader for one open video source. */
type ClipSink = ReturnType<typeof frameSink>;

/** A clip's source time at timeline time `t`. */
function sourceTimeAt(span: ClipSpan, t: number): number {
  const speed = span.clip.speed && span.clip.speed > 0 ? span.clip.speed : 1;
  return span.clip.in + Math.max(0, t - span.start) * speed;
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
  private still: Frame | null = null;
  private opened: Promise<ClipSink | null> | null = null;
  private reopened = false;

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
      // A small pool keeps the render's canvas allocation flat over thousands
      // of frames.
      this.sink = frameSink(track, undefined, { poolSize: 4 });
      return this.sink;
    })());
  }

  /** The clip's picture at source time `at`, or a missing frame when the
   * source has none — a still-less video, or a time past its end. A render
   * never reports `pending`: it waits for the decode instead of moving on. */
  async frameAt(at: number): Promise<Frame> {
    const sink = await this.open();
    if (this.still) return this.still;
    if (!sink) return MISSING_FRAME;
    let wrapped;
    try {
      wrapped = await sink.getCanvas(Math.max(0, at));
    } catch (err) {
      // A long render can outlive the signed link it opened with. Reopening
      // resolves the URL again, which is enough when the link was simply
      // re-minted; a second failure is a real one and stops the render.
      if (this.reopened) throw err;
      this.reopened = true;
      this.input?.dispose();
      this.input = null;
      this.sink = null;
      this.opened = null;
      const reopened = await this.open();
      if (!reopened) throw err;
      wrapped = await reopened.getCanvas(Math.max(0, at));
    }
    if (!wrapped) return MISSING_FRAME;
    return {
      kind: "ready",
      image: wrapped.canvas,
      width: wrapped.canvas.width,
      height: wrapped.canvas.height,
    };
  }

  dispose() {
    this.input?.dispose();
    this.input = null;
    this.sink = null;
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
          ? cueWordWindows(cue)
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
              doc.subtitles.wordHighlight ? wi : undefined,
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
function overlayRamps(spans: ClipSpan[]): { head: number; tail: number }[] {
  const ramps = spans.map(() => ({ head: 0, tail: 0 }));
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
  // A still has no sound, and handing its URL to the audio reader would fail on
  // a file that is not a media container at all.
  const silent = (asset: MediaAsset) => asset.type === "image";

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
        muted: sp.clip.muted || silent(sp.asset),
        fadeIn: ramps[i].head,
        fadeOut: ramps[i].tail,
      });
    });
  }
  for (const a of doc.audioClips) {
    const asset = byId.get(a.assetId);
    if (!asset || a.hidden || a.start >= duration) continue;
    items.push({
      file: resolve(asset),
      in: a.in,
      out: a.out,
      start: a.start,
      volume: a.volume,
      speed: a.speed,
      fadeIn: a.fadeIn,
      fadeOut: a.fadeOut,
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
            muted: sp.clip.muted || !!sp.clip.hidden || silent(sp.asset),
            speed: sp.clip.speed,
            volume: sp.clip.volume,
            transition: sp.transitionOut,
          },
        ]);

  return {
    duration,
    clips,
    items,
    fadeIn: projectFadeSeconds(doc.fadeIn, duration),
    fadeOut: projectFadeSeconds(doc.fadeOut, duration),
  };
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

  const codec = await getFirstEncodableVideoCodec(VIDEO_CODECS, {
    width: settings.width,
    height: settings.height,
  });
  if (!codec) throw new Error("This browser can't encode video.");

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
    format: new Mp4OutputFormat({ fastStart: "reserve" }),
    target: new StreamTarget(writable, { chunked: true }),
  });

  try {
    const video = new CanvasSource(canvas, {
      codec,
      quality: new Quality({ bitrate: bitrateFor(settings) }),
    });
    // Reserving the index space needs a packet ceiling per track. The video's
    // is exact — one packet per frame; the audio's is the mix's sample count
    // over the smallest samples-per-packet a codec here uses (Opus's 960; AAC
    // packs more), plus slack for encoder priming.
    output.addVideoTrack(video, { frameRate: settings.fps, maximumPacketCount: frames + 8 });
    let audio: AudioBufferSource | null = null;
    if (mix) {
      const audioCodec = await getFirstEncodableAudioCodec(["aac", "opus"], {
        numberOfChannels: AUDIO_CHANNELS,
        sampleRate: AUDIO_RATE,
      });
      if (audioCodec) {
        audio = new AudioBufferSource({
          codec: audioCodec,
          quality: new Quality({ bitrate: 192_000 }),
        });
        output.addAudioTrack(audio, { maximumPacketCount: Math.ceil(mix.length / 960) + 32 });
      }
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
  private behind: SubjectMaskCompositor | null = null;
  private fxScratch: RasterSurface | null = null;
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

  private readerFor(asset: MediaAsset): ClipReader {
    let r = this.readers.get(asset.id);
    if (!r) this.readers.set(asset.id, (r = new ClipReader(asset, () => this.resolve(asset))));
    return r;
  }

  /** Draw the whole cut at timeline time `t` onto the canvas. */
  async drawAt(t: number): Promise<void> {
    const { canvas, comp, doc, stamps } = this;
    const W = canvas.width;
    const H = canvas.height;
    comp.clear();

    const master = this.spans.find((sp) => t >= sp.start && t < sp.start + sp.len);
    if (master) {
      const plan = trackZeroPlan(master, this.spans, t);
      if (plan.backdrop) {
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
    for (const r of this.readers.values()) r.dispose();
    this.readers.clear();
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
    return !!(await getFirstEncodableVideoCodec(VIDEO_CODECS, {
      width: settings.width,
      height: settings.height,
    }));
  } catch {
    return false;
  }
}
