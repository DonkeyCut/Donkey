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
  StreamTarget,
  type VideoCodec,
} from "mediabunny";
import { renderMix, type MixClip, type MixItem, type MixSpec } from "./audioMix";
import { FrameCompositor, MISSING_FRAME, type Frame } from "./composite";
import { overlayPlan, trackZeroPlan } from "./framePlan";
import { frameSink, openMedia, videoTrackOf } from "./mediaRead";
import { getClipSpans, overlayLayers, projectDuration, spanSequence } from "./store";
import { captionStyle, cueOverlay, cueWordWindows, laneCues, subtitleLaneCount, trackPos } from "./subtitles";
import { renderOverlayPng } from "./textRender";
import { frameOf, isFullRect, overlayAnimStyle, projectFadeSeconds, rectOf } from "./types";
import type { ClipSpan, MediaAsset, TextOverlay } from "./types";
import type { ExportDoc, ExportSettings } from "./exportClient";

/** Audio is written at the rate and width a delivery file wants, rather than
 * the 16 kHz mono a speech model reads. */
const AUDIO_RATE = 48000;
const AUDIO_CHANNELS = 2;

/** Video codecs to try, best first. */
const VIDEO_CODECS: VideoCodec[] = ["avc", "hevc", "vp9", "av1"];

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
class ClipReader {
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
      this.sink = frameSink(track, undefined, 4);
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
interface StampedLayer {
  overlay: TextOverlay;
  start: number;
  end: number;
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
function stampText(doc: ExportDoc): StampedLayer[] {
  const duration = projectDuration(doc);
  const layers: StampedLayer[] = [];

  for (const o of doc.overlays) {
    if (o.start >= duration || !o.text.trim()) continue;
    layers.push({ overlay: o, start: o.start, end: Math.min(o.end, duration) });
  }

  if (doc.subtitles.showOnVideo) {
    const capStyle = captionStyle(doc.subtitles.style);
    // Wrap in design space (1080 short side) from the project ratio — the same
    // width the preview passes, whatever the render size.
    const designWidth = frameOf(doc.aspect).w;
    for (let lane = 0; lane < subtitleLaneCount(doc.subtitles); lane++) {
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

  constructor(
    private width: number,
    private height: number
  ) {}

  async bitmapFor(layer: StampedLayer): Promise<ImageBitmap> {
    let bitmap = this.drawn.get(layer);
    if (!bitmap) {
      const png = await renderOverlayPng(layer.overlay, this.width, this.height);
      bitmap = await createImageBitmap(png);
      this.drawn.set(layer, bitmap);
    }
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
  }

  dispose() {
    for (const bitmap of this.drawn.values()) bitmap.close();
    this.drawn.clear();
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

  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(settings.width, settings.height)
      : Object.assign(document.createElement("canvas"), {
          width: settings.width,
          height: settings.height,
        });
  const comp = new FrameCompositor(canvas);

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

  const stamps = new StampCache(settings.width, settings.height);
  const readers = new Map<string, ClipReader>();
  const readerFor = (asset: MediaAsset) => {
    let r = readers.get(asset.id);
    if (!r) readers.set(asset.id, (r = new ClipReader(asset, () => resolve(asset))));
    return r;
  };

  try {
    const video = new CanvasSource(canvas, { codec, bitrate: bitrateFor(settings) });
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
        audio = new AudioBufferSource({ codec: audioCodec, bitrate: 192_000 });
        output.addAudioTrack(audio, { maximumPacketCount: Math.ceil(mix.length / 960) + 32 });
      }
    }
    await output.start();

    // The audio is one buffer for the whole timeline, so it goes in before the
    // frames rather than being interleaved with them.
    if (audio && mix) await audio.add(mix);

    const layers = stampText(doc);
    stop();

    const spans = getClipSpans(doc.clips, doc.assets, 0);
    const overlayTracks = [...new Set(overlayLayers(doc.clips).map((c) => c.track))];
    // Span geometry is a property of the document, which does not change while
    // rendering — so it is computed once rather than per overlay per frame.
    const byTrack = new Map(overlayTracks.map((track) => [track, getClipSpans(doc.clips, doc.assets, track)]));
    const spansOf = (track: number) => byTrack.get(track) ?? [];
    const spanOfClip = new Map<string, ClipSpan>();
    for (const list of byTrack.values()) for (const sp of list) spanOfClip.set(sp.clip.id, sp);

    for (let i = 0; i < frames; i++) {
      stop();
      const t = i * frameDur;
      comp.clear();

      const master = spans.find((sp) => t >= sp.start && t < sp.start + sp.len);
      if (master) {
        const plan = trackZeroPlan(master, spans, t);
        if (plan.backdrop) {
          const frame = await readerFor(plan.backdrop.span.asset).frameAt(plan.backdrop.at);
          comp.drawLayer(frame, plan.backdrop.span.clip, false, 1, t);
        }
        const masterFrame = master.clip.hidden
          ? MISSING_FRAME
          : await readerFor(master.asset).frameAt(sourceTimeAt(master, t));
        const incFrame = plan.incoming
          ? await readerFor(plan.incoming.asset).frameAt(sourceTimeAt(plan.incoming, t))
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
              dx: plan.masterFxFrac.dx * settings.width,
              dy: plan.masterFxFrac.dy * settings.height,
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

      for (const layer of overlayPlan(overlayTracks, spansOf, t)) {
        const span = spanOfClip.get(layer.clip.id);
        if (!span) continue;
        const frame = await readerFor(layer.asset).frameAt(sourceTimeAt(span, t));
        const rect = rectOf(layer.clip);
        const cover = layer.clip.fit === "fill" || (layer.clip.fit == null && isFullRect(rect));
        comp.drawIntoRect(frame, rect, cover, layer.alpha, t, layer.zoom, layer.clip);
      }

      await drawStamps(canvas, layers, stamps, t);
      stamps.retire(t);
      comp.drawProjectFade(projectFadeGain(doc, t, duration));

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
    stamps.dispose();
    for (const r of readers.values()) r.dispose();
    readers.clear();
  }
}

/** Draw the text layers live at `t` over the finished picture. */
async function drawStamps(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  layers: StampedLayer[],
  stamps: StampCache,
  t: number
) {
  const ctx = canvas.getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) return;
  for (const layer of layers) {
    if (t < layer.start || t >= layer.end) continue;
    ctx.drawImage(await stamps.bitmapFor(layer), 0, 0, canvas.width, canvas.height);
  }
}

/**
 * Whether this render should happen in the tab.
 *
 * Three things have to hold. The cut has to be one a tab can carry — past ten
 * minutes or 4K it belongs on the worker, which has a whole machine rather than
 * a share of one. The browser has to offer scratch storage, because the render
 * writes its file to origin-private disk rather than the heap. And the browser
 * has to actually be able to encode it: whether WebCodecs offers a video
 * encoder for these dimensions is a fact about the browser, not about the
 * project, and asking after the render has already been routed here leaves
 * nowhere to go. Answering all three first means a browser that cannot carry
 * the render quietly renders on the worker, the way every cloud export did
 * before this path existed.
 */
export async function canRenderInBrowser(
  doc: ExportDoc,
  settings: ExportSettings
): Promise<boolean> {
  const duration = projectDuration(doc);
  const pixels = settings.width * settings.height;
  if (!(duration > 0) || duration > 10 * 60 || pixels > 3840 * 2160) return false;
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
