import { spawn, type ChildProcess } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { atempoChain, hasStream, num, videoColorInfo } from "./util";
import { projectFadeSeconds, regionPx, TRANSITION_XFADE, TRANSITION_ZOOM, type ColorGrade, type TransitionStyle } from "../lib/types";
import { effectFilterLines, gradeToFfmpegFilter, lookFilterLines, shortestTurn, sortedKeys, type OverlayKey } from "@donkeycut/effects-kit";

// The render pipeline itself: spec in, finished mp4 out. Shared by the local
// engine's job registry (jobs.ts) and the cloud render worker, which stage
// media differently but must produce byte-identical renders.

export interface ExportSpec {
  projectId: string;
  /** Where the render lands instead of a stamped file in exports/: "hls" is the
   * share's streaming ladder, "preview"
   * writes the project's low-res hover proxy, "card" the opening seconds the
   * cloud worker derives a shared link's preview image from. */
  target?: "export" | "preview" | "card" | "hls";
  width: number;
  height: number;
  fps: number;
  crf: number;
  preset: string;
  duration: number;
  /** Whole-video fades, seconds: in from black / out to black, applied to the
   * final composite and mix after all overlays and soundtrack. */
  fadeIn?: number;
  fadeOut?: number;
  clips: {
    file: string;
    in: number;
    out: number;
    muted: boolean;
    /** Gain on the clip's own audio, 0..1.5; absent = 1 (unchanged). */
    volume?: number;
    /** "fit" letterboxes (default); "fill" covers the region and crops. */
    fit?: "fit" | "fill";
    panX?: number; // crop-window pan -1..1 (fill mode)
    panY?: number;
    /** Region of the frame this clip fills; absent = full frame. */
    frame?: { x: number; y: number; w: number; h: number };
    speed?: number; // playback rate, default 1
    /** Transition into the next clip, in timeline seconds (overlap). */
    transition?: number;
    /** Transition look id, resolved to an xfade name through the
     * TRANSITION_XFADE allowlist (unknown ids render as a plain fade). Cross
     * zoom renders as the fade plus zoom ramps on both segments' overlap
     * windows. */
    transitionStyle?: string;
    /** This clip's own entrance/exit animation, baked into the segment's
     * head/tail window: fade (audio follows), zoom, pop, or a slide
     * against black. Unknown styles render as a fade. */
    animIn?: { style: string; seconds: number };
    animOut?: { style: string; seconds: number };
    /** Preset filter look id + strength 0..1, baked into the segment (the
     * spec carries only the id — the chain is built server-side). */
    look?: string;
    lookAmount?: number;
    /** Hidden clips keep their slot but render black + silent. */
    hidden?: boolean;
    /** A still image: looped for the clip's length instead of trimmed. */
    image?: boolean;
    /** Manual color adjustments, baked into this clip's segment. */
    grade?: ColorGrade;
    /** Client-painted grayscale coverage trimming this clip's picture (white
     * keeps the pixel; feather and invert are baked into the pictures): one
     * full-frame still, or a sampled `frames` sequence for a keyframed mask
     * covering the segment's own [0, dur]. `subject` trims by the shared
     * person matte (`behindMask`) instead — inverted keeps the picture off
     * the person, feather softens the matte edge (design px). */
    mask?: {
      file?: string;
      frames?: { file: string; duration: number }[];
      subject?: { invert?: boolean; feather?: number };
    };
    /** Keyframed pose track, seconds from the segment's own start: x/y move
     * the picture's center (frame fractions), scale multiplies it, rotation
     * turns it. Opacity keys ride the painted mask's luma, so the graph
     * never needs an animatable alpha filter. */
    kf?: { t: number; x: number; y: number; scale: number; rotation: number; opacity: number }[];
    /** Client-painted border ring (a stroked rounded rect along the clip's
     * box, transparent elsewhere), full-frame sized; overlaid onto the
     * segment before fades, masks and pose so it rides the clip. */
    border?: string;
  }[];
  /** Video tracks composited over the track-0 `clips`, lowest track first. */
  overlayVideos?: {
    file: string;
    in: number;
    out: number;
    start: number; // timeline position, seconds
    track: number;
    /** Region of the frame this overlay fills; absent = full frame. */
    frame?: { x: number; y: number; w: number; h: number };
    fit?: "fit" | "fill";
    panX?: number; // crop-window pan -1..1 (fill mode)
    panY?: number;
    muted: boolean;
    /** Gain on the clip's own audio, 0..1.5; absent = 1 (unchanged). */
    volume?: number;
    speed?: number;
    /** Transition ramps, timeline seconds from this overlay's head/tail. On
     * an upper track a fade is an alpha fade (the tracks beneath show
     * through); a cross transition arrives as the incoming clip's headFade
     * while the outgoing clip stays opaque under it, and cross zoom adds a
     * tailZoom/headZoom pair riding that overlap. The audio fades with the
     * picture. */
    headFade?: number;
    tailFade?: number;
    headZoom?: number;
    tailZoom?: number;
    /** A still image: looped for the clip's length instead of trimmed. */
    image?: boolean;
    /** Manual color adjustments, baked into this overlay's segment. */
    grade?: ColorGrade;
    /** Preset filter look id + strength (footage overlays only — image
     * overlays may carry alpha the look chain would flatten). */
    look?: string;
    lookAmount?: number;
    /** Client-painted grayscale coverage trimming this overlay's picture,
     * box-sized (a letterboxed segment pads out to its box when masked);
     * `subject` trims by the shared person matte instead. */
    mask?: {
      file?: string;
      frames?: { file: string; duration: number }[];
      subject?: { invert?: boolean; feather?: number };
    };
    /** Keyframed pose track, seconds from this overlay's start. */
    kf?: { t: number; x: number; y: number; scale: number; rotation: number; opacity: number }[];
    /** Client-painted border ring, box-sized (a letterboxed segment pads out
     * to its box when bordered); overlaid onto the segment so it rides the
     * clip through fades, masks and pose. */
    border?: string;
  }[];
  audio: {
    file: string;
    in: number;
    out: number;
    start: number;
    volume: number;
    fadeIn?: number;
    fadeOut?: number;
    /** Playback rate (detached-audio clips inherit their video clip's speed). */
    speed?: number;
    /** Voiceover ducking: while this clip plays, every other sound drops to
     * this gain (0..1). Ducking clips never duck each other. */
    duck?: number;
  }[];
  /** Overlay elements. A static element is one full-frame PNG windowed with
   * `enable`. An animated element ships `frames` — a region-cropped slideshow
   * (file + seconds each, repeats allowed) played via the concat demuxer and
   * overlaid at (x, y), with `blank` (a region-sized transparent PNG) padding
   * the timeline before and after its window. */
  overlays: {
    file?: string;
    start: number;
    end: number;
    x?: number;
    y?: number;
    blank?: string;
    frames?: { file: string; duration: number }[];
    /** The element trims by the shared person matte (needs `behindMask` and
     * a `frames` stream): inverted keeps it off the person — behind the
     * speaker, in its own lane order — and feather softens the matte edge. */
    subject?: { invert?: boolean; feather?: number };
    /** Its row: lane 0 is the top of the stack. Elements composite deepest
     * lane first, and effects interleave with them by the same number. */
    lane?: number;
  }[];
  /** The page-rendered person mask video (grayscale, white = person) for the
   * behind-tagged overlays: starts at `from` timeline seconds and covers the
   * union of their windows. */
  behindMask?: { file: string; from: number };
  /** Time-ranged effect elements — the spec carries ids and knobs; the
   * LGPL-safe chains are built here from the kit's recipes. Each one grades
   * what plays under it: the video, the overlay tracks, and every element on
   * a lane below its own. */
  effects?: {
    effect: string;
    amount?: number;
    focus?: { x: number; y: number };
    /** Seconds a zoom takes to reach its depth. */
    ramp?: number;
    /** Its row in the element stack; lane 0 is the top. */
    lane?: number;
    start: number;
    end: number;
  }[];
  /** Burned-in subtitle stills. Kept apart from `overlays` (titles may
   * overlap each other): each subtitle track (`lane`, absent = 0) is
   * non-overlapping and chronological within itself and renders as one
   * concat-demuxer slideshow, so karaoke word windows don't multiply inputs.
   * Tracks overlap each other in time (one language each). */
  captions?: { file: string; start: number; end: number; lane?: number }[];
}

/** What the pipeline needs from its caller's job record: the staging dir the
 * overlay PNGs were written into, the output path, and the mutable fields the
 * run reports through (progress, the live ffmpeg process for cancellation,
 * the rolling stderr log, and an externally-set error that wins over the
 * generic exit message). The engine's Job and the worker's claimed row both
 * satisfy it structurally. */
export interface RenderHandle {
  tmpDir: string;
  outPath: string;
  progress: number;
  error?: string;
  proc?: ChildProcess;
  log: string[];
}

/** The H.264 encoder to use, probed once against the same `ffmpeg` the exports
 * spawn. Prefer libx264 (CRF + presets) when the build carries it — the dev
 * Homebrew ffmpeg does. The bundled engine ffmpeg is LGPL (`--disable-gpl`), so
 * it has no libx264 and `-preset`/`-crf` don't exist there; fall back to the
 * always-present VideoToolbox hardware H.264 encoder. */
let h264EncoderCache: Promise<"libx264" | "h264_videotoolbox"> | null = null;
export function h264Encoder(): Promise<"libx264" | "h264_videotoolbox"> {
  return (h264EncoderCache ??= new Promise((resolve) => {
    let out = "";
    const proc = spawn("ffmpeg", ["-hide_banner", "-encoders"]);
    proc.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    proc.on("error", () => resolve("h264_videotoolbox"));
    proc.on("close", () => resolve(/\blibx264\b/.test(out) ? "libx264" : "h264_videotoolbox"));
  }));
}

/** VideoToolbox constant quality (1–100, higher = better) from the CRF knob the
 * presets carry (lower CRF = better). Maps the 19/24/30 tiers to ~66/57/46. */
export function vtQuality(crf: number) {
  return Math.round(Math.max(35, Math.min(80, 100 - crf * 1.8)));
}

async function resolveMedia(
  statFn: typeof stat,
  mediaPathFor: (file: string) => string,
  file: string
) {
  const p = mediaPathFor(file);
  const info = await statFn(p).catch(() => null);
  if (!info?.isFile()) throw new Error(`Media file missing from project: ${file}`);
  return p;
}

/**
 * Filter prefix converting a wide-gamut/HDR source (phone footage: BT.2020
 * primaries with an HLG or PQ transfer) down to the BT.709 SDR the export is
 * tagged as, or "" for an SDR source. The blind `format=yuv420p` squeeze keeps
 * BT.2020 code values, and players reading them as 709 wash the clip out —
 * visible whenever phone footage sits next to Cut-rendered (already-709)
 * clips. The native `colorspace` filter has no HLG/PQ transfer, so the input
 * is pinned to bt2020-10, a close stand-in over HLG's SDR-compatible range;
 * the 10-bit format hop feeds it a planar format it accepts (decoders hand
 * HDR frames over as p010, which it rejects).
 *
 * The matrix decides, the way players decide. Social-app transcodes (8-bit
 * H.264) keep BT.2020 primaries + HLG transfer tags from the phone original
 * but write an explicit bt709 matrix — players read those as plain 709 SDR,
 * so converting them shifts hue and saturation against what every player
 * shows (verified frame-for-frame against WebKit playback). Convert only
 * when the matrix itself is BT.2020, or when it's untagged and the wide
 * primaries/transfer tags are the only signal there is.
 */
export function sdrConvert(c: Awaited<ReturnType<typeof videoColorInfo>>) {
  if (c == null) return "";
  const matrix = c.matrix && c.matrix !== "unknown" ? c.matrix : null;
  const wide =
    matrix?.startsWith("bt2020") === true ||
    (matrix === null &&
      (c.primaries === "bt2020" ||
        c.transfer === "arib-std-b67" ||
        c.transfer === "smpte2084"));
  return wide ? "format=yuv420p10le,colorspace=all=bt709:iall=bt2020:format=yuv420p," : "";
}

/** A clip's effective playback rate (>0, default 1). */
function clipRate(c: ExportSpec["clips"][number]) {
  return c.speed && c.speed > 0 ? c.speed : 1;
}

/** A clip's frame region in even pixels, or null when it fills the whole frame
 * (the common case, which keeps the plain full-frame filter path). */

/**
 * Spawn ffmpeg for one pass, tracking `job.proc` so a cancel kills the live
 * process, bounding silence with the stall watchdog, and (when `onProgress` is
 * given) reporting the `time=` cursor from stderr. Rejects with a readable
 * message on a non-zero exit or a missing binary. Shared by the encode pass and
 * the rotation-strip remux.
 */
export function runFfmpeg(
  job: RenderHandle,
  args: string[],
  onProgress?: (seconds: number) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    job.proc = proc;
    // Stall watchdog: legit exports can run long, so bound silence, not total
    // time — kill only if ffmpeg emits nothing for STALL_MS.
    const STALL_MS = 120_000;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error("Export stalled — no ffmpeg output for 120s."));
      }, STALL_MS);
      watchdog.unref();
    };
    bump();
    proc.stderr.on("data", (chunk: Buffer) => {
      bump();
      const text = chunk.toString();
      job.log.push(text);
      if (job.log.length > 200) job.log.shift();
      if (onProgress) {
        const m = /time=(\d+):(\d+):([\d.]+)/.exec(text);
        if (m) onProgress(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
      }
    });
    proc.on("error", (err) => {
      clearTimeout(watchdog);
      reject(
        err.message.includes("ENOENT")
          ? new Error("ffmpeg was not found. Install it with: brew install ffmpeg")
          : err
      );
    });
    proc.on("close", (code) => {
      clearTimeout(watchdog);
      if (code === 0) resolve();
      else if (job.error) reject(new Error(job.error));
      else reject(new Error(`ffmpeg exited with code ${code}.\n${job.log.slice(-8).join("")}`));
    });
  });
}

/** The pipeline's edges into the world: staged-media checks, list-file
 * writes, stream probes, the encoder probe, and the ffmpeg runs. `runExport`
 * takes them as a parameter so the filtergraph tests can build the real graph
 * for a spec with these stubbed. */
export interface ExportPipelineIO {
  stat: typeof stat;
  writeFile: typeof writeFile;
  hasStream: typeof hasStream;
  videoColorInfo: typeof videoColorInfo;
  h264Encoder: () => Promise<"libx264" | "h264_videotoolbox">;
  runFfmpeg: typeof runFfmpeg;
}

const realIO: ExportPipelineIO = { stat, writeFile, hasStream, videoColorInfo, h264Encoder, runFfmpeg };

/** Render `spec` into `job.outPath`. `mediaPathFor` maps a spec media file
 * name to its staged path on disk (the engine reads the project folder; the
 * worker reads its download dir); overlay/caption PNGs are read from
 * `job.tmpDir` by base name in both. */
export async function runExport(
  job: RenderHandle,
  spec: ExportSpec,
  mediaPathFor: (file: string) => string,
  io: ExportPipelineIO = realIO
) {
  if (spec.clips.length === 0) throw new Error("Nothing to export.");
  const { width: W, height: H, fps } = spec;

  // Tracks number 0..N bottom-up: track 0 folds sequentially into the base
  // picture, the rest overlay it in track order (highest last = frontmost).
  // Within a track, earlier clips composite first, so a dissolving pair
  // blends the incoming clip in over the outgoing one.
  const overlayVideos = [...(spec.overlayVideos ?? [])].sort(
    (a, b) => a.track - b.track || a.start - b.start
  );
  const clipFmt = "yuv420p";
  const padColor = "black";
  // One ffmpeg input per distinct media file (from the project folder),
  // plus one per uploaded overlay PNG.
  // Still images are excluded here: a plain `-i file` decodes one frame, so
  // each image clip/overlay gets its own looped input below instead. Gap
  // spacers (empty file) reference no media at all — they render as black.
  const mediaFiles = [
    ...new Set(
      [
        ...spec.clips.filter((c) => !c.image),
        ...spec.audio,
        ...overlayVideos.filter((o) => !o.image),
      ]
        .map((c) => c.file)
        .filter(Boolean)
    ),
  ];
  const audioPresence = new Map<string, boolean>();
  const videoPresence = new Map<string, boolean>();
  // file → filter prefix folding a wide-gamut/HDR source down to BT.709 (or "").
  const colorFix = new Map<string, string>();
  const inputs: string[] = [];
  const inputIndex = new Map<string, number>();
  // Counted explicitly: the concat input below carries extra flags, so the
  // args array is not a clean ["-i", path] pair per input.
  let nInputs = 0;
  // Resolve paths in order first so ffmpeg input indices stay deterministic,
  // then probe every file's streams concurrently.
  const paths = await Promise.all(mediaFiles.map((f) => resolveMedia(io.stat, mediaPathFor, f)));
  mediaFiles.forEach((f, i) => {
    inputIndex.set(f, nInputs++);
    inputs.push("-i", paths[i]);
  });
  await Promise.all(
    mediaFiles.map(async (f, i) => {
      // A probe that errors (timeout, non-zero exit) must not be read as
      // "no stream" — that would silently drop real audio to silence or real
      // video to black. Genuine absence returns false with no error, so on a
      // probe error we assume the stream is present and let ffmpeg map it.
      let audioProbeFailed = false;
      const hasAudio = await io.hasStream(paths[i], "a", () => (audioProbeFailed = true));
      audioPresence.set(f, hasAudio || audioProbeFailed);
      let videoProbeFailed = false;
      const hasVideo = await io.hasStream(paths[i], "v", () => (videoProbeFailed = true));
      videoPresence.set(f, hasVideo || videoProbeFailed);
      // A failed color probe (null) means no conversion — SDR passthrough.
      colorFix.set(f, sdrConvert(await io.videoColorInfo(paths[i])));
    })
  );
  // Animated overlays: each is its own concat-demuxer slideshow (region-sized
  // frames with transparent filler around the element's window), the exact
  // mechanism the caption lanes use. Static overlays stay single PNG inputs.
  const animOverlayInput = new Map<number, number>();
  for (let k = 0; k < spec.overlays.length; k++) {
    const o = spec.overlays[k];
    if (o.frames?.length && o.blank) {
      const blank = path.join(job.tmpDir, path.basename(o.blank));
      const lines = ["ffconcat version 1.0"];
      if (o.start > 1e-3) lines.push(`file '${blank}'`, `duration ${num(o.start)}`);
      let cursor = o.start;
      for (const f of o.frames) {
        if (f.duration < 1e-4) continue;
        lines.push(
          `file '${path.join(job.tmpDir, path.basename(f.file))}'`,
          `duration ${num(f.duration)}`
        );
        cursor += f.duration;
      }
      if (spec.duration - cursor > 1e-3) {
        lines.push(`file '${blank}'`, `duration ${num(spec.duration - cursor)}`);
      }
      const list = path.join(job.tmpDir, `overlay_anim_${k}.ffconcat`);
      await io.writeFile(list, lines.join("\n") + "\n");
      animOverlayInput.set(k, nInputs++);
      inputs.push("-f", "concat", "-safe", "0", "-i", list);
    } else if (o.file) {
      inputIndex.set(o.file, nInputs++);
      inputs.push("-i", path.join(job.tmpDir, path.basename(o.file)));
    }
  }
  let behindMaskInput: number | undefined;
  if (spec.behindMask) {
    behindMaskInput = nInputs++;
    inputs.push("-i", path.join(job.tmpDir, path.basename(spec.behindMask.file)));
  }

  // Looped input per still image, sized to the clip's timeline length so the
  // segment fills without a source trim. Keyed by clip/overlay identity since
  // two clips of the same image can have different lengths.
  const imageClipInput = new Map<number, number>();
  for (let j = 0; j < spec.clips.length; j++) {
    const c = spec.clips[j];
    if (!c.image || !c.file) continue;
    const dur = Math.max(0.1, (c.out - c.in) / clipRate(c));
    imageClipInput.set(j, nInputs++);
    inputs.push("-loop", "1", "-t", num(dur), "-framerate", String(fps), "-i", await resolveMedia(io.stat, mediaPathFor, c.file));
  }
  const imageOverlayInput = new Map<(typeof overlayVideos)[number], number>();
  for (const oc of overlayVideos) {
    if (!oc.image) continue;
    const ospeed = oc.speed && oc.speed > 0 ? oc.speed : 1;
    const olen = Math.max(0.1, (oc.out - oc.in) / ospeed);
    imageOverlayInput.set(oc, nInputs++);
    inputs.push("-loop", "1", "-t", num(olen), "-framerate", String(fps), "-i", await resolveMedia(io.stat, mediaPathFor, oc.file));
  }

  // Client-painted clip masks: a resting mask is one looped still the length
  // of its segment; a keyframed one plays as its own concat slideshow, both
  // on the segment's local clock (the mask multiplies in before tpad).
  const maskInput = async (
    mk: NonNullable<ExportSpec["clips"][number]["mask"]>,
    dur: number,
    tag: string
  ): Promise<number | undefined> => {
    if (mk.frames?.length) {
      const lines = ["ffconcat version 1.0"];
      for (const f of mk.frames) {
        if (f.duration < 1e-4) continue;
        lines.push(
          `file '${path.join(job.tmpDir, path.basename(f.file))}'`,
          `duration ${num(f.duration)}`
        );
      }
      const list = path.join(job.tmpDir, `${tag}.ffconcat`);
      await io.writeFile(list, lines.join("\n") + "\n");
      const idx = nInputs++;
      inputs.push("-f", "concat", "-safe", "0", "-i", list);
      return idx;
    }
    if (!mk.file) return undefined;
    const idx = nInputs++;
    inputs.push("-loop", "1", "-t", num(dur), "-framerate", String(fps), "-i", path.join(job.tmpDir, path.basename(mk.file)));
    return idx;
  };
  const clipMaskInput = new Map<number, number>();
  for (let j = 0; j < spec.clips.length; j++) {
    const c = spec.clips[j];
    if (!c.mask) continue;
    const dur = c.file ? Math.max(0.1, (c.out - c.in) / clipRate(c)) : Math.max(0, c.out - c.in);
    const idx = await maskInput(c.mask, dur, `mask_clip_${j}`);
    if (idx !== undefined) clipMaskInput.set(j, idx);
  }
  const overlayMaskInput = new Map<(typeof overlayVideos)[number], number>();
  for (let k = 0; k < overlayVideos.length; k++) {
    const oc = overlayVideos[k];
    if (!oc.mask) continue;
    const ospeed = oc.speed && oc.speed > 0 ? oc.speed : 1;
    const olen = Math.max(0.1, (oc.out - oc.in) / ospeed);
    const idx = await maskInput(oc.mask, olen, `mask_ovl_${k}`);
    if (idx !== undefined) overlayMaskInput.set(oc, idx);
  }
  // Border rings loop as stills for their segment's length, like mask files.
  const borderStill = (file: string, dur: number): number => {
    const idx = nInputs++;
    inputs.push("-loop", "1", "-t", num(dur), "-framerate", String(fps), "-i", path.join(job.tmpDir, path.basename(file)));
    return idx;
  };
  const clipBorderInput = new Map<number, number>();
  for (let j = 0; j < spec.clips.length; j++) {
    const c = spec.clips[j];
    if (!c.border) continue;
    const dur = c.file ? Math.max(0.1, (c.out - c.in) / clipRate(c)) : Math.max(0, c.out - c.in);
    clipBorderInput.set(j, borderStill(c.border, dur));
  }
  const overlayBorderInput = new Map<(typeof overlayVideos)[number], number>();
  for (const oc of overlayVideos) {
    if (!oc.border) continue;
    const ospeed = oc.speed && oc.speed > 0 ? oc.speed : 1;
    const olen = Math.max(0.1, (oc.out - oc.in) / ospeed);
    overlayBorderInput.set(oc, borderStill(oc.border, olen));
  }

  // One concat-demuxer input per subtitle track: within a track cues never
  // overlap, so each plays as a slideshow with transparent filler
  // ("sub_blank.png", uploaded with the stills) covering the gaps. Tracks
  // (languages) overlap each other, so each gets its own input.
  const captionLanes = new Map<number, NonNullable<ExportSpec["captions"]>>();
  for (const c of spec.captions ?? []) {
    if (c.end <= c.start) continue;
    const lane = c.lane ?? 0;
    if (!captionLanes.has(lane)) captionLanes.set(lane, []);
    captionLanes.get(lane)!.push(c);
  }
  const captionInputs: number[] = [];
  for (const [lane, entries] of [...captionLanes.entries()].sort((a, b) => a[0] - b[0])) {
    entries.sort((a, b) => a.start - b.start);
    const blank = path.join(job.tmpDir, "sub_blank.png");
    const lines = ["ffconcat version 1.0"];
    let cursor = 0;
    for (const c of entries) {
      const from = Math.max(c.start, cursor);
      if (c.end - from < 1e-3) continue;
      if (from - cursor > 1e-3) lines.push(`file '${blank}'`, `duration ${num(from - cursor)}`);
      lines.push(
        `file '${path.join(job.tmpDir, path.basename(c.file))}'`,
        `duration ${num(c.end - from)}`
      );
      cursor = c.end;
    }
    if (spec.duration - cursor > 1e-3) {
      lines.push(`file '${blank}'`, `duration ${num(spec.duration - cursor)}`);
    }
    const list = path.join(job.tmpDir, `captions_${lane}.ffconcat`);
    await io.writeFile(list, lines.join("\n") + "\n");
    captionInputs.push(nInputs++);
    inputs.push("-f", "concat", "-safe", "0", "-i", list);
  }

  const filters: string[] = [];

  // Per-clip timeline length (source span compressed/expanded by speed). A
  // gap spacer (no file) keeps its exact length: flooring it at 0.1s would
  // land everything after the gap later than the timeline shows, drifting
  // burned-in captions off the picture.
  const clipDur = (c: ExportSpec["clips"][number]) =>
    c.file ? Math.max(0.1, (c.out - c.in) / clipRate(c)) : Math.max(0, c.out - c.in);
  // Where each track-0 segment lands on the joined timeline: transitions
  // pad their overlap, so the layout is the plain running sum of durations.
  const clipStarts: number[] = [];
  {
    let accStart = 0;
    for (const c of spec.clips) {
      clipStarts.push(accStart);
      accStart += clipDur(c);
    }
  }

  // The shared person matte, split once per subject-mask consumer: elements
  // trimmed to (or off) the person, and subject-masked clips on any track.
  // Each consumer takes one split, negates it when inverted, and blurs it by
  // its feather.
  const outScale = Math.min(W, H) / 1080;
  const clipDrawable = (c: ExportSpec["clips"][number]) =>
    (c.image || videoPresence.get(c.file)) && !c.hidden;
  const subjectActive = !!spec.behindMask && behindMaskInput !== undefined;
  const matteConsumers = !subjectActive
    ? 0
    : spec.overlays.filter((o) => o.subject && o.frames?.length && o.blank).length +
      overlayVideos.filter((oc) => oc.mask?.subject && (oc.image || videoPresence.get(oc.file)))
        .length +
      spec.clips.filter((c) => c.mask?.subject && clipDrawable(c)).length;
  let matteN = 0;
  if (subjectActive && matteConsumers > 0) {
    filters.push(
      `[${behindMaskInput}:v]fps=${fps},scale=${W}:${H},setsar=1,format=gray,` +
        `tpad=start_duration=${num(Math.max(0, spec.behindMask!.from))}:color=black[bh_src]`
    );
    filters.push(
      matteConsumers > 1
        ? `[bh_src]split=${matteConsumers}` +
            Array.from({ length: matteConsumers }, (_, i) => `[bhs${i}]`).join("")
        : `[bh_src]null[bhs0]`
    );
  }
  // ---- Keyframed clip poses as filter expressions -------------------------
  // The pose track is piecewise-linear with the ends held flat, exactly the
  // kit evaluator: v0 + Σ Δi·clip((V−ti)/(ti+1−ti),0,1) builds that shape as
  // one monotone expression, safe inside overlay/scale/rotate.
  const piecewiseExpr = (keys: { t: number; v: number }[], varExpr: string): string => {
    const ks = [...keys].sort((a, b) => a.t - b.t);
    let e = `${num(ks[0].v)}`;
    for (let i = 0; i < ks.length - 1; i++) {
      const dt = Math.max(1e-6, ks[i + 1].t - ks[i].t);
      const dv = ks[i + 1].v - ks[i].v;
      if (Math.abs(dv) < 1e-9) continue;
      e += `+${num(dv)}*clip((${varExpr}-${num(ks[i].t)})/${num(dt)},0,1)`;
    }
    return `(${e})`;
  };
  /** The pose track's rotation values unwrapped into cumulative degrees, so
   * the expression lerps the short way around like the kit evaluator. */
  const unwrappedRotation = (kf: OverlayKey[]): { t: number; v: number }[] => {
    const ks = sortedKeys(kf);
    const out: { t: number; v: number }[] = [{ t: ks[0].t, v: ks[0].rotation }];
    for (let i = 1; i < ks.length; i++) {
      out.push({
        t: ks[i].t,
        v: out[i - 1].v + shortestTurn(ks[i - 1].rotation, ks[i].rotation),
      });
    }
    return out;
  };
  const varies = (kf: OverlayKey[], field: "x" | "y" | "scale" | "rotation") =>
    kf.some((k) => Math.abs(k[field] - kf[0][field]) > 1e-6);
  /** The rotate/scale filters a keyed segment runs before positioning, on
   * its own local clock. `boxW`/`boxH` give the constant rotate canvas. */
  const poseTransformFilters = (
    kf: OverlayKey[],
    boxW: number,
    boxH: number
  ): string => {
    const ks = sortedKeys(kf);
    let chain = "";
    if (varies(ks, "rotation") || Math.abs(ks[0].rotation) > 1e-6) {
      const diag = 2 * Math.ceil(Math.hypot(boxW, boxH) / 2);
      const rot = piecewiseExpr(unwrappedRotation(ks), "t");
      chain += `,rotate=a='${rot}*PI/180':ow=${diag}:oh=${diag}:c=black@0.0`;
    }
    if (varies(ks, "scale") || Math.abs(ks[0].scale - 1) > 1e-6) {
      const sc = piecewiseExpr(ks.map((k) => ({ t: k.t, v: k.scale })), "t");
      chain += `,scale=w='trunc(iw*${sc}/2)*2':h=-2:eval=frame`;
    }
    return chain;
  };
  /** The overlay x/y expressions placing a keyed segment's center at its
   * pose, with the key clock offset to `startAt` on the consuming stream's
   * timeline (0 for a local-clock base). */
  const posePositionExprs = (kf: OverlayKey[], startAt: number): { x: string; y: string } => {
    const ks = sortedKeys(kf);
    const v = startAt > 1e-9 ? `(t-${num(startAt)})` : "t";
    return {
      x: `'${piecewiseExpr(ks.map((k) => ({ t: k.t, v: k.x })), v)}*${W}-w/2'`,
      y: `'${piecewiseExpr(ks.map((k) => ({ t: k.t, v: k.y })), v)}*${H}-h/2'`,
    };
  };

  /** One matte split, shaped for a consumer. Every counted consumer takes
   * exactly one, so the split's outputs all connect. */
  const nextMatte = (
    tag: string,
    subject: { invert?: boolean; feather?: number }
  ): string => {
    let cur = `bhs${matteN++}`;
    if (subject.invert) {
      filters.push(`[${cur}]negate[${tag}n]`);
      cur = `${tag}n`;
    }
    if (subject.feather && subject.feather > 0) {
      filters.push(`[${cur}]gblur=sigma=${num((subject.feather * outScale) / 4)}[${tag}b]`);
      cur = `${tag}b`;
    }
    return cur;
  };

  /** One edge effect on a segment's head or tail window. `zoom` ramps scale
   * (settling in on the head, pushing in on the tail); `xfade` runs the named
   * xfade transition against a backdrop — the label in `bg` (a neighbor's
   * held frame), or a black frame when absent; `pop` scales the picture up
   * from / down to 80% with a fade over the same backdrop. */
  type EdgeFx = { kind: "zoom" | "pop" | "xfade"; secs: number; xfade?: string; bg?: string };

  /** Emit `core` into `[out]` with the head/tail edge effects confined to
   * their windows and `fades` appended. Each effected window is sliced out
   * (split → trim → fx → concat) so per-frame effects stay inside the short
   * ramp; plain fades ride `fades` inline instead. `w`×`h` is the segment's
   * constant frame size; `tag` uniquifies intermediate labels. Shared by the
   * track-0 segments and the overlay-track segments. */
  const pushEdgeFx = (
    core: string,
    dur: number,
    head: EdgeFx | null,
    tail: EdgeFx | null,
    w: number,
    h: number,
    fmt: string,
    fades: string,
    out: string,
    tag: string
  ) => {
    const zoomRamp = (side: "head" | "tail", secs: number) => {
      // A head ramp settles TRANSITION_ZOOM→1 (zoom out), a tail ramp pushes
      // 1→TRANSITION_ZOOM (zoom in); zoompan clamps z below 1 itself, so the
      // plain arithmetic needs no guards.
      const frames = Math.max(1, Math.round(secs * fps) - 1);
      const k = num(TRANSITION_ZOOM - 1);
      const z =
        side === "tail"
          ? `1+${k}*in/${frames}`
          : `${num(TRANSITION_ZOOM)}-${k}*in/${frames}`;
      return (
        `zoompan=z=${z}:x=iw/2-(iw/zoom/2):y=ih/2-(ih/zoom/2)` +
        `:d=1:s=${w}x${h}:fps=${fps},setsar=1,format=${fmt}`
      );
    };
    // Emit one sliced window's effect from `[inLab]` to `[outLab]`. The
    // multi-input effects push their own filter lines.
    const applyFx = (fx: EdgeFx, side: "head" | "tail", inLab: string, outLab: string) => {
      const d = num(fx.secs);
      if (fx.kind === "zoom") {
        filters.push(`[${inLab}]${zoomRamp(side, fx.secs)}[${outLab}]`);
        return;
      }
      // The backdrop behind the window: a neighbor's held frame when given
      // (an abutting cut), else black (timeline ends and gaps).
      let bg = fx.bg;
      if (!bg) {
        bg = `xb${tag}_${side}`;
        filters.push(`color=c=black:s=${w}x${h}:r=${fps}:d=${d},format=${fmt}[${bg}]`);
      }
      if (fx.kind === "xfade") {
        // Entering: the backdrop hands off to the picture; exiting: the
        // picture hands off to the backdrop. Anim style ids map straight to
        // xfade names (probed: slideleft moves the frame leftward, so it
        // enters from the right edge and exits off the left; cover/reveal
        // and wipes share the same direction footprints).
        filters.push(
          side === "head"
            ? `[${bg}][${inLab}]xfade=transition=${fx.xfade}:duration=${d}:offset=0[${outLab}]`
            : `[${inLab}][${bg}]xfade=transition=${fx.xfade}:duration=${d}:offset=0[${outLab}]`
        );
        return;
      }
      // Pop: scale 80%↔100% over the window (even dimensions for yuv420p),
      // centered over the backdrop. With a held-frame backdrop the picture
      // alpha-fades so the neighbor stays visible behind it; over black the
      // plain fade is the same thing cheaper.
      const p = side === "head" ? `min(t/${d},1)` : `1-min(t/${d},1)`;
      const sc = `sc${tag}_${side}`;
      const scaleExpr = `scale=w='trunc(iw*(0.8+0.2*(${p}))/2)*2':h=-2:eval=frame`;
      if (fx.bg) {
        filters.push(
          `[${inLab}]format=yuva420p,` +
            `fade=t=${side === "head" ? "in" : "out"}:st=0:d=${d}:alpha=1,${scaleExpr}[${sc}]`
        );
        filters.push(
          `[${bg}][${sc}]overlay=x=(W-w)/2:y=(H-h)/2:shortest=1,format=${fmt}[${outLab}]`
        );
        return;
      }
      filters.push(`[${inLab}]${scaleExpr}[${sc}]`);
      filters.push(
        `[${bg}][${sc}]overlay=x=(W-w)/2:y=(H-h)/2:shortest=1,` +
          `fade=t=${side === "head" ? "in" : "out"}:st=0:d=${d},format=${fmt}[${outLab}]`
      );
    };
    const hs = head && head.secs > 0.01 ? head : null;
    const ts = tail && tail.secs > 0.01 ? tail : null;
    if (!hs && !ts) {
      filters.push(`${core}${fades}[${out}]`);
      return;
    }
    const slices: { from: number; to: number; fx?: EdgeFx; side: "head" | "tail" }[] = [];
    if (hs) slices.push({ from: 0, to: hs.secs, fx: hs, side: "head" });
    const mid0 = hs ? hs.secs : 0;
    const mid1 = ts ? dur - ts.secs : dur;
    if (mid1 - mid0 > 0.01) slices.push({ from: mid0, to: mid1, side: "head" });
    if (ts) slices.push({ from: dur - ts.secs, to: dur, fx: ts, side: "tail" });
    filters.push(`${core},split=${slices.length}${slices.map((_, k) => `[zs${tag}_${k}]`).join("")}`);
    slices.forEach((sl, k) => {
      const cut = `zc${tag}_${k}`;
      // setpts clears the constant-frame-rate metadata the slice xfades
      // demand — re-stamp it on every cut.
      filters.push(
        `[zs${tag}_${k}]trim=${num(sl.from)}:${num(sl.to)},setpts=PTS-STARTPTS,fps=${fps}[${cut}]`
      );
      if (sl.fx) applyFx(sl.fx, sl.side, cut, `zp${tag}_${k}`);
      else filters.push(`[${cut}]null[zp${tag}_${k}]`);
    });
    // concat drops the stream's constant-frame-rate metadata and a downstream
    // xfade join refuses a variable-rate input — re-stamp it.
    filters.push(
      slices.map((_, k) => `[zp${tag}_${k}]`).join("") +
        `concat=n=${slices.length}:v=1:a=0,fps=${fps}${fades}[${out}]`
    );
  };

  /** The edge effect a clip animation asks for, or null when it's a plain
   * fade (fades ride the inline `fade`/`afade` filters instead of a slice).
   * Unknown styles fall back to the fade path. */
  const animEdgeFx = (a: { style: string; seconds: number } | undefined, max: number): EdgeFx | null => {
    if (!a || a.seconds <= 0.01 || max <= 0.01) return null;
    const secs = Math.min(a.seconds, max);
    if (a.style === "zoom") return { kind: "zoom", secs };
    if (a.style === "pop") return { kind: "pop", secs };
    if (/^slide(left|right|up|down)$/.test(a.style)) {
      return { kind: "xfade", secs, xfade: a.style };
    }
    return null;
  };

  /** Whether an animation renders through the inline fade filters. */
  const isFadeAnim = (a: { style: string; seconds: number } | undefined) =>
    !!a && a.seconds > 0.01 && !animEdgeFx(a, Infinity);

  // A clip animation at an abutting hard cut plays over the neighbor's held
  // frame instead of black — an entrance covers the previous clip's last
  // frame, an exit reveals the next clip's first frame. Black remains where
  // there is no neighbor: the timeline's ends, gaps (the adjacent entry is a
  // spacer), and hidden neighbors. Zoom never uncovers the frame, so it needs
  // no backdrop. Precomputed so pass 1 can defer these animations and split
  // off the freeze sources the second pass consumes.
  const freezable = (c?: ExportSpec["clips"][number]) =>
    !!c && !!c.file && !c.hidden && (!!c.image || !!videoPresence.get(c.file));
  const effAnimIn = (j: number) => {
    const p = spec.clips[j - 1];
    return p && (p.transition ?? 0) > 0.01 ? undefined : spec.clips[j].animIn;
  };
  const effAnimOut = (j: number) => {
    const n = spec.clips[j + 1];
    return n && (spec.clips[j].transition ?? 0) > 0.01 ? undefined : spec.clips[j].animOut;
  };
  const backdropAnim = (a?: { style: string; seconds: number }) =>
    a && a.seconds > 0.01 && a.style !== "zoom" ? a : undefined;
  const headBd = spec.clips.map(
    (c, j) => !!(freezable(c) && backdropAnim(effAnimIn(j)) && freezable(spec.clips[j - 1]))
  );
  const tailBd = spec.clips.map(
    (c, j) => !!(freezable(c) && backdropAnim(effAnimOut(j)) && freezable(spec.clips[j + 1]))
  );
  const needFirstFreeze = spec.clips.map((_, j) => j > 0 && tailBd[j - 1]);
  const needLastFreeze = spec.clips.map((_, j) => j < spec.clips.length - 1 && headBd[j + 1]);

  // Per-clip normalized video + audio segments for the join below.
  spec.clips.forEach((c, j) => {
    const idx = c.image ? imageClipInput.get(j)! : inputIndex.get(c.file)!;
    const speed = clipRate(c);
    const dur = clipDur(c);
    const prevC = spec.clips[j - 1];
    const nextC = spec.clips[j + 1];
    // Cross zoom renders as the fade join plus zoom ramps riding the overlap
    // window on both segments (clamped like the join clamps its overlap).
    const czOverlap = (a: (typeof spec.clips)[number], aDur: number, bDur: number) =>
      a.transitionStyle === "crosszoom"
        ? Math.min(a.transition ?? 0, aDur * 0.9, bDur * 0.9)
        : 0;
    const czHead = prevC ? czOverlap(prevC, clipDur(prevC), dur) : 0;
    const czTail = nextC ? czOverlap(c, dur, clipDur(nextC)) : 0;
    // A transitioned joint owns its edges: with a live overlap into or out of
    // this clip, that side's animation is held (running both would fight over
    // the same window) — `transition` in the spec is already the clamped live
    // overlap, so 0 means a hard cut and the animation plays. Matches the
    // preview's suppression exactly.
    const animIn = prevC && (prevC.transition ?? 0) > 0.01 ? undefined : c.animIn;
    const animOut = nextC && (c.transition ?? 0) > 0.01 ? undefined : c.animOut;
    // The clip's own animations own their edge windows (fade animations ride
    // the inline fade filters below); cross zoom fills a side its animation
    // leaves free. Clamped so head+tail never overrun the segment. Backdrop
    // animations are deferred to the second pass, which runs them against the
    // neighbor's held frame — only their audio fade stays here.
    const animInNow = headBd[j] ? undefined : animIn;
    const animOutNow = tailBd[j] ? undefined : animOut;
    let headFx = animEdgeFx(animInNow, dur);
    let tailFx = animEdgeFx(animOutNow, dur - (headFx?.secs ?? 0));
    const hf = isFadeAnim(animInNow) ? Math.min(animInNow!.seconds, dur) : 0;
    const tf = isFadeAnim(animOutNow) ? Math.min(animOutNow!.seconds, dur - hf) : 0;
    // The sound of a fade animation follows the picture whether the fade
    // renders inline (over black) or in the backdrop pass.
    const ahf = animIn?.style === "fade" ? Math.min(animIn.seconds, dur) : 0;
    const atf =
      animOut?.style === "fade" ? Math.min(animOut.seconds, Math.max(0, dur - ahf)) : 0;
    if (!headFx && hf <= 0.01 && czHead > 0.01) {
      headFx = { kind: "zoom", secs: Math.min(czHead, dur) };
    }
    if (!tailFx && tf <= 0.01 && czTail > 0.01) {
      tailFx = { kind: "zoom", secs: Math.min(czTail, dur - (headFx?.secs ?? 0)) };
    }
    // A still's looped input is already the right length at `fps`; it has no
    // source span to trim. Footage trims `in..out` and re-times by speed.
    const timebase = c.image
      ? `[${idx}:v]setpts=PTS-STARTPTS`
      : `[${idx}:v]trim=${num(c.in)}:${num(c.out)},setpts=(PTS-STARTPTS)/${num(speed)}`;
    if ((c.image || videoPresence.get(c.file)) && !c.hidden) {
      const region = regionPx(c.frame, W, H);
      let frame: string;
      if (region) {
        // A regioned track-0 clip (split-screen half) scales into its rect,
        // then pads out to the full frame with black around it. The rect may
        // reach past the frame (an oversized focus box), and pad rejects
        // placement outside its area — so pad to the box holding both, then
        // crop the frame window back out.
        const { rx, ry, rw, rh } = region;
        const bx = Math.min(0, rx);
        const by = Math.min(0, ry);
        const bw = Math.max(W, rx + rw) - bx;
        const bh = Math.max(H, ry + rh) - by;
        const win = bw > W || bh > H ? `,crop=${W}:${H}:${-bx}:${-by}` : "";
        frame =
          c.fit === "fill"
            ? `scale=${rw}:${rh}:force_original_aspect_ratio=increase,` +
              `crop=${rw}:${rh}:(iw-ow)*${num(0.5 + Math.max(-1, Math.min(1, c.panX ?? 0)) / 2)}` +
              `:(ih-oh)*${num(0.5 + Math.max(-1, Math.min(1, c.panY ?? 0)) / 2)},` +
              `pad=${bw}:${bh}:${rx - bx}:${ry - by}:color=${padColor}${win}`
            : `scale=${rw}:${rh}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
              `pad=${bw}:${bh}:${rx - bx}+(${rw}-iw)/2:${ry - by}+(${rh}-ih)/2:color=${padColor}${win}`;
      } else {
        frame =
          c.fit === "fill"
            ? // Cover the frame, then crop; the pan chooses the visible window.
              `scale=${W}:${H}:force_original_aspect_ratio=increase,` +
              `crop=${W}:${H}:(iw-ow)*${num(0.5 + Math.max(-1, Math.min(1, c.panX ?? 0)) / 2)}` +
              `:(ih-oh)*${num(0.5 + Math.max(-1, Math.min(1, c.panY ?? 0)) / 2)}`
            : `scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
              `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${padColor}`;
      }
      // setpts/speed rescales the clip's duration on the timeline (footage);
      // a still just replays its looped input.
      // The grade sits after the color conversion (so it acts on the same
      // BT.709 values the preview shows) and before the terminal format.
      let core = `${timebase},fps=${fps},${frame},setsar=1,${colorFix.get(c.file) ?? ""}${gradeToFfmpegFilter(c.grade)}format=${clipFmt}`;
      // The look bakes in after grade + framing, before the edge effects, so
      // animations move already-graded pixels (matching the preview order).
      if (c.look) {
        const lines = lookFilterLines(`lki${j}`, `lko${j}`, c.look, c.lookAmount, H, clipFmt, `c${j}`);
        if (lines) {
          filters.push(`${core}[lki${j}]`);
          filters.push(...lines);
          core = `[lko${j}]null`;
        }
      }
      // The border ring lands after the look (true stroke color) and before
      // the fades, so it fades and masks with the clip like the preview.
      const brIdx = clipBorderInput.get(j);
      if (brIdx !== undefined) {
        filters.push(`${core}[cbi${j}]`);
        filters.push(`[cbi${j}][${brIdx}:v]overlay=0:0:eof_action=pass,format=${clipFmt}[cbo${j}]`);
        core = `[cbo${j}]null`;
      }
      const fades =
        (hf > 0.01 ? `,fade=t=in:st=0:d=${num(hf)}` : "") +
        (tf > 0.01 ? `,fade=t=out:st=${num(Math.max(0, dur - tf))}:d=${num(tf)}` : "");
      // A neighbor's backdrop animation freezes a frame of this segment —
      // split the copies it needs off the pre-backdrop picture.
      const nFz = (needFirstFreeze[j] ? 1 : 0) + (needLastFreeze[j] ? 1 : 0);
      const segOut = nFz > 0 ? `vseg${j}` : `v${j}`;
      const mkIdx = clipMaskInput.get(j);
      const subjMask = subjectActive && matteConsumers > 0 ? c.mask?.subject : undefined;
      const keyed = !!c.kf?.length;
      if (mkIdx !== undefined || subjMask || keyed) {
        // Masked or keyframed track-0 clip, composed in the preview's order:
        // the painted coverage multiplies first (it rides the clip), the
        // pose transforms and positions the result over a transparent base,
        // the person matte — frame-anchored — trims last, and a black base
        // restores the constant-size opaque frame the join expects. The
        // multiply chains (alphaextract → blend → alphamerge) compose with
        // any alpha the segment carries.
        pushEdgeFx(core, dur, headFx, tailFx, W, H, clipFmt, fades, `vmr${j}`, `c${j}`);
        let cur = `vmr${j}`;
        if (mkIdx !== undefined) {
          filters.push(`[${mkIdx}:v]fps=${fps},scale=${W}:${H},setsar=1,format=gray[cmk${j}]`);
          filters.push(`[${cur}]format=rgba,split[cm0_${j}][cm1_${j}]`);
          filters.push(`[cm1_${j}]alphaextract[cma${j}]`);
          filters.push(`[cma${j}][cmk${j}]blend=all_mode=multiply[cmm${j}]`);
          filters.push(`[cm0_${j}][cmm${j}]alphamerge[cmc${j}]`);
          cur = `cmc${j}`;
        } else {
          filters.push(`[${cur}]format=rgba[cmc${j}]`);
          cur = `cmc${j}`;
        }
        if (keyed) {
          const tf = poseTransformFilters(c.kf!, W, H);
          if (tf) {
            filters.push(`[${cur}]null${tf}[ckt${j}]`);
            cur = `ckt${j}`;
          }
          const pos = posePositionExprs(c.kf!, 0);
          filters.push(
            `color=c=black@0.0:s=${W}x${H}:r=${fps}:d=${num(dur)},format=yuva420p[ckb${j}]`
          );
          filters.push(
            `[ckb${j}][${cur}]overlay=x=${pos.x}:y=${pos.y}:eof_action=pass[ckp${j}]`
          );
          cur = `ckp${j}`;
        }
        if (subjMask) {
          const matte = nextMatte(`bsc${j}`, subjMask);
          // Clone-pad past the matte's own end so a segment running longer
          // than the matte window never shortens the join.
          filters.push(
            `[${matte}]trim=${num(clipStarts[j])}:${num(clipStarts[j] + dur)},` +
              `setpts=PTS-STARTPTS,fps=${fps},tpad=stop_mode=clone:stop_duration=${num(dur)},` +
              `trim=0:${num(dur)},setpts=PTS-STARTPTS,fps=${fps}[cms${j}]`
          );
          filters.push(`[${cur}]format=rgba,split[cs0_${j}][cs1_${j}]`);
          filters.push(`[cs1_${j}]alphaextract[csa${j}]`);
          filters.push(`[csa${j}][cms${j}]blend=all_mode=multiply[csm${j}]`);
          filters.push(`[cs0_${j}][csm${j}]alphamerge[csc${j}]`);
          cur = `csc${j}`;
        }
        filters.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${num(dur)}[cmb${j}]`);
        filters.push(
          `[cmb${j}][${cur}]overlay=0:0:shortest=1,format=${clipFmt},fps=${fps}[${segOut}]`
        );
      } else {
        pushEdgeFx(core, dur, headFx, tailFx, W, H, clipFmt, fades, segOut, `c${j}`);
      }
      if (nFz > 0) {
        filters.push(
          `[vseg${j}]split=${nFz + 1}[v${j}]` +
            (needFirstFreeze[j] ? `[vff${j}]` : "") +
            (needLastFreeze[j] ? `[vfl${j}]` : "")
        );
      }
    } else {
      // No video stream, or a hidden clip: the slot plays black. trim+setpts
      // clear the frame-rate stamp a transitioned join's xfade demands —
      // re-stamp it.
      filters.push(
        `color=c=black:s=${W}x${H}:r=${fps},trim=0:${num(dur)},setpts=PTS-STARTPTS,fps=${fps},format=${clipFmt}[v${j}]`
      );
    }
    if (!c.muted && !c.hidden && audioPresence.get(c.file)) {
      const tempo = speed !== 1 ? `${atempoChain(speed)},` : "";
      const vol = (c.volume ?? 1) !== 1 ? `volume=${num(c.volume ?? 1)},` : "";
      // The picture's fade edges carry the sound with them; zoom edges don't.
      const afades =
        (ahf > 0.01 ? `,afade=t=in:st=0:d=${num(ahf)}` : "") +
        (atf > 0.01 ? `,afade=t=out:st=${num(Math.max(0, dur - atf))}:d=${num(atf)}` : "");
      filters.push(
        `[${idx}:a]atrim=${num(c.in)}:${num(c.out)},asetpts=PTS-STARTPTS,${tempo}` +
          `aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,${vol}` +
          `apad=whole_dur=${num(dur)},atrim=0:${num(dur)}${afades}[a${j}]`
      );
    } else {
      filters.push(
        `anullsrc=r=44100:cl=stereo,atrim=0:${num(dur)},asetpts=PTS-STARTPTS[a${j}]`
      );
    }
  });

  // Second pass: the backdrop animations. Each slices its edge window and
  // runs the effect against the neighbor's held frame — frozen via tpad
  // clone from the copies split off above, so a slide-in covers the previous
  // clip's last frame and a slide-out reveals the next clip's first frame.
  // Slides become cover/reveal (the backdrop stays put); pop alpha-blends
  // over the frozen frame; fade — and any unknown stored style — crossfades.
  const segLabel = spec.clips.map((_, j) => `v${j}`);
  const backdropFx = (
    a: { style: string; seconds: number },
    side: "head" | "tail",
    secs: number,
    bg: string
  ): EdgeFx => {
    if (a.style === "pop") return { kind: "pop", secs, bg };
    if (/^slide(left|right|up|down)$/.test(a.style)) {
      const dir = a.style.slice(5);
      return { kind: "xfade", secs, xfade: `${side === "head" ? "cover" : "reveal"}${dir}`, bg };
    }
    return { kind: "xfade", secs, xfade: "fade", bg };
  };
  spec.clips.forEach((c, j) => {
    if (!headBd[j] && !tailBd[j]) return;
    const dur = clipDur(c);
    if (headBd[j]) {
      const a = backdropAnim(effAnimIn(j))!;
      const d = Math.min(a.seconds, dur);
      const durPrev = clipDur(spec.clips[j - 1]);
      // fps is re-stamped before tpad — cloning needs a live frame rate, and
      // trim+setpts strip it (without this the freeze collapses to 1 frame).
      filters.push(
        `[vfl${j - 1}]trim=${num(Math.max(0, durPrev - 0.05))}:${num(durPrev)},setpts=PTS-STARTPTS,fps=${fps},` +
          `tpad=stop_mode=clone:stop_duration=${num(d + 0.5)},trim=0:${num(d)},` +
          `setpts=PTS-STARTPTS,fps=${fps}[fzh${j}]`
      );
      pushEdgeFx(
        `[${segLabel[j]}]null`,
        dur,
        backdropFx(a, "head", d, `fzh${j}`),
        null,
        W,
        H,
        clipFmt,
        "",
        `vhb${j}`,
        `hb${j}`
      );
      segLabel[j] = `vhb${j}`;
    }
    if (tailBd[j]) {
      const a = backdropAnim(effAnimOut(j))!;
      const d = Math.min(a.seconds, dur);
      filters.push(
        `[vff${j + 1}]trim=0:0.05,setpts=PTS-STARTPTS,fps=${fps},` +
          `tpad=stop_mode=clone:stop_duration=${num(d + 0.5)},trim=0:${num(d)},` +
          `setpts=PTS-STARTPTS,fps=${fps}[fzt${j}]`
      );
      pushEdgeFx(
        `[${segLabel[j]}]null`,
        dur,
        null,
        backdropFx(a, "tail", d, `fzt${j}`),
        W,
        H,
        clipFmt,
        "",
        `vtb${j}`,
        `tb${j}`
      );
      segLabel[j] = `vtb${j}`;
    }
  });

  // Join the segments. Clips abut — a transition claims no layout — so every
  // join keeps the accumulator's full length. A transitioned join pads the
  // incoming segment's head with its cloned first frame and runs the xfade
  // across the outgoing clip's last blend-window seconds: the held frame
  // arrives over the live tail, and the real segment starts exactly at the
  // cut. Its sound is a tail fade on the outgoing side and a hard join. The
  // rest hard-cut (concat). Fold left so mixed sequences chain correctly.
  let vAcc = segLabel[0];
  let aAcc = "a0";
  let acc = clipDur(spec.clips[0]); // running timeline length of the accumulator
  for (let j = 1; j < spec.clips.length; j++) {
    const prev = spec.clips[j - 1];
    const durJ = clipDur(spec.clips[j]);
    // The blend can't exceed most of either clip, matching the editor clamp.
    const d = Math.min(prev.transition ?? 0, acc * 0.9, durJ * 0.9);
    const vOut = `vj${j}`;
    const aOut = `aj${j}`;
    if (d > 0.01) {
      const offset = Math.max(0, acc - d);
      // The style id resolves through the allowlist map; anything unknown
      // (or an old spec without a style) renders as a plain fade.
      const kind = TRANSITION_XFADE[prev.transitionStyle as TransitionStyle] ?? "fade";
      filters.push(`[${segLabel[j]}]tpad=start_duration=${num(d)}:start_mode=clone[vh${j}]`);
      filters.push(`[${vAcc}][vh${j}]xfade=transition=${kind}:duration=${num(d)}:offset=${num(offset)}[${vOut}]`);
      filters.push(`[${aAcc}]afade=t=out:st=${num(offset)}:d=${num(d)}[ah${j}]`);
      filters.push(`[ah${j}][a${j}]concat=n=2:v=0:a=1[${aOut}]`);
    } else {
      // concat emits a microsecond timebase with no frame-rate stamp, and a
      // later transitioned join hands this accumulator to xfade, which
      // demands both of its inputs carry the same 1/fps stamp — re-stamp it.
      filters.push(`[${vAcc}][${segLabel[j]}]concat=n=2:v=1:a=0,fps=${fps}[${vOut}]`);
      filters.push(`[${aAcc}][a${j}]concat=n=2:v=0:a=1[${aOut}]`);
    }
    acc = acc + durJ;
    vAcc = vOut;
    aAcc = aOut;
  }

  // Composite the video stack bottom→top: the overlay tracks draw over the
  // track-0 base in track order. A full-frame layer covers; a regioned one
  // shares the frame (split half) or floats (PiP). Overlay audio (unless
  // muted) mixes in below.
  const overlaySoundLabels: string[] = [];
  let ovk = 0;
  // Overlay one track clip onto `onto`, returning the new label; also queues
  // its audio.
  const addOverlay = (oc: (typeof overlayVideos)[number], onto: string): string => {
    if (!oc.image && !videoPresence.get(oc.file)) return onto;
    const idx = oc.image ? imageOverlayInput.get(oc)! : inputIndex.get(oc.file)!;
    const ospeed = oc.speed && oc.speed > 0 ? oc.speed : 1;
    const olen = Math.max(0.1, (oc.out - oc.in) / ospeed);
    const end = Math.min(oc.start + olen, spec.duration);
    const region = regionPx(oc.frame, W, H);
    const cover = oc.fit === "fill" || (oc.fit == null && !region);
    // Transition ramps, clamped so head+tail never overrun the segment. On an
    // upper track the fades are alpha fades — the clip dissolves against
    // whatever is beneath it (a cross transition ships as the incoming clip's
    // head fade, blending it in over the still-opaque outgoing clip).
    const hz = Math.max(0, Math.min(oc.headZoom ?? 0, olen));
    const tz = Math.max(0, Math.min(oc.tailZoom ?? 0, olen - hz));
    const hf = Math.max(0, Math.min(oc.headFade ?? 0, olen));
    const tf = Math.max(0, Math.min(oc.tailFade ?? 0, olen - hf));
    const ramped = hz > 0.01 || tz > 0.01;
    const maskIdx = overlayMaskInput.get(oc);
    const subjMask = subjectActive && matteConsumers > 0 ? oc.mask?.subject : undefined;
    const keyed = !!oc.kf?.length;
    const boxW = region ? region.rw : W;
    const boxH = region ? region.rh : H;
    let framing: string;
    let pos: string;
    // A fill overlay's crop window follows the clip's pan, matching the
    // preview compositor.
    const panCrop =
      `:(iw-ow)*${num(0.5 + Math.max(-1, Math.min(1, oc.panX ?? 0)) / 2)}` +
      `:(ih-oh)*${num(0.5 + Math.max(-1, Math.min(1, oc.panY ?? 0)) / 2)}`;
    if (!region) {
      framing = cover
        ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}${panCrop}`
        : `scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
      pos = cover ? "0:0" : `x=(${W}-w)/2:y=(${H}-h)/2`;
    } else {
      const { rx, ry, rw, rh } = region;
      framing = cover
        ? `scale=${rw}:${rh}:force_original_aspect_ratio=increase,crop=${rw}:${rh}${panCrop}`
        : `scale=${rw}:${rh}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
      pos = cover ? `${rx}:${ry}` : `x=${rx}+(${rw}-w)/2:y=${ry}+(${rh}-h)/2`;
    }
    // zoompan needs a constant frame size — and a mask trims at the box, so
    // both pad a letterboxed segment out to its exact box with transparent
    // margins (the tracks beneath keep showing through) and anchor the
    // overlay at the box origin. The pad joins the chain after the look
    // bakes in, so the look grades the opaque scaled picture and never
    // flattens the transparent margins.
    // A bordered letterboxed segment also pads to its box: the ring strokes
    // the box edge, so the segment must span the box to carry it.
    const boxed =
      (ramped || maskIdx !== undefined || !!subjMask || keyed || !!oc.border) && !cover;
    const boxPad = boxed
      ? `,format=yuva420p,pad=${boxW}:${boxH}:(ow-iw)/2:(oh-ih)/2:color=black@0.0`
      : "";
    if (boxed) pos = region ? `${region.rx}:${region.ry}` : "0:0";
    const fmt = hf > 0.01 || tf > 0.01 || boxed ? "yuva420p" : "yuv420p";
    // The look chain reads the pre-pad picture, which is opaque.
    const lookFmt = boxed ? "yuv420p" : fmt;
    const fades =
      (hf > 0.01 ? `,fade=t=in:st=0:d=${num(hf)}:alpha=1` : "") +
      (tf > 0.01 ? `,fade=t=out:st=${num(Math.max(0, olen - tf))}:d=${num(tf)}:alpha=1` : "");
    const k = ovk++;
    const seg = `ovv${k}`;
    // A still replays its looped input; footage trims its source span and
    // re-times by speed. tpad then delays the clip to its timeline start.
    const timebase = oc.image
      ? `[${idx}:v]setpts=PTS-STARTPTS`
      : `[${idx}:v]trim=${num(oc.in)}:${num(oc.out)},setpts=(PTS-STARTPTS)/${num(ospeed)}`;
    let core = `${timebase},fps=${fps},${framing},setsar=1,${colorFix.get(oc.file) ?? ""}${gradeToFfmpegFilter(oc.grade)}format=${lookFmt}`;
    // Looks bake into footage overlays only: an image may carry alpha, which
    // the look chain's internal filters would flatten onto black over the
    // tracks beneath. The alpha fades stay safe: they apply after the look.
    if (oc.look && !oc.image) {
      const lines = lookFilterLines(`olki${k}`, `olko${k}`, oc.look, oc.lookAmount, H, lookFmt, `o${k}`);
      if (lines) {
        filters.push(`${core}[olki${k}]`);
        filters.push(...lines);
        core = `[olko${k}]null`;
      }
    }
    if (boxPad) core += boxPad;
    // The border ring lands after the look and box pad, before the edge
    // ramps, so it fades and masks with the clip like the preview.
    const obIdx = overlayBorderInput.get(oc);
    if (obIdx !== undefined) {
      filters.push(`${core}[obi${k}]`);
      filters.push(`[obi${k}][${obIdx}:v]overlay=0:0:eof_action=pass,format=${fmt}[obo${k}]`);
      core = `[obo${k}]null`;
    }
    const pre = `ovp${k}`;
    pushEdgeFx(
      core,
      olen,
      hz > 0.01 ? { kind: "zoom", secs: hz } : null,
      tz > 0.01 ? { kind: "zoom", secs: tz } : null,
      boxW,
      boxH,
      fmt,
      fades,
      pre,
      `o${k}`
    );
    // A masked overlay multiplies the painted coverage into whatever alpha
    // the segment already carries (transparent pad, alpha fades), then keeps
    // its alpha through the tpad/overlay below. A keyed pose rotates and
    // scales on the segment's local clock before the delay.
    let masked = pre;
    if (maskIdx !== undefined) {
      filters.push(`[${maskIdx}:v]fps=${fps},scale=${boxW}:${boxH},setsar=1,format=gray[omk${k}]`);
      filters.push(`[${pre}]format=rgba,split[om0${k}][om1${k}]`);
      filters.push(`[om1${k}]alphaextract[oma${k}]`);
      filters.push(`[oma${k}][omk${k}]blend=all_mode=multiply[omm${k}]`);
      filters.push(`[om0${k}][omm${k}]alphamerge,format=yuva420p[omc${k}]`);
      masked = `omc${k}`;
    }
    if (keyed) {
      const tf = poseTransformFilters(oc.kf!, boxW, boxH);
      if (tf) {
        filters.push(`[${masked}]format=rgba${tf},format=yuva420p[okt${k}]`);
        masked = `okt${k}`;
      }
    }
    // The zoom slices' concat drops the stream's frame-rate metadata, and
    // tpad converts start_duration to a frame count through it — without the
    // fps re-stamp it pads zero frames and the overlay lands early.
    filters.push(`[${masked}]fps=${fps},tpad=start_duration=${num(oc.start)}[${seg}]`);
    const next = `vovv${k}`;
    const enable = `enable='between(t,${num(oc.start)},${num(end)})'`;
    if (subjMask) {
      // Subject-masked overlay clip: the delayed segment lands on the full
      // frame at its spot — a static pad, or an expression overlay onto a
      // transparent base when keyed — its alpha multiplies by the timeline-
      // aligned matte, and the trimmed layer composites at the origin.
      const matte = nextMatte(`bso${k}`, subjMask);
      if (keyed) {
        const kpos = posePositionExprs(oc.kf!, oc.start);
        filters.push(
          `color=c=black@0.0:s=${W}x${H}:r=${fps}:d=${num(spec.duration)},format=yuva420p[osb${k}]`
        );
        filters.push(
          `[osb${k}][${seg}]overlay=x=${kpos.x}:y=${kpos.y}:eof_action=pass[osp${k}]`
        );
      } else {
        // The box may reach past the frame; pad to the box holding both and
        // crop the frame window back out (pad rejects placement outside its
        // area).
        const padX = region ? region.rx : 0;
        const padY = region ? region.ry : 0;
        const bx = Math.min(0, padX);
        const by = Math.min(0, padY);
        const bw = Math.max(W, padX + boxW) - bx;
        const bh = Math.max(H, padY + boxH) - by;
        const win = bw > W || bh > H ? `,crop=${W}:${H}:${-bx}:${-by}` : "";
        filters.push(
          `[${seg}]format=rgba,pad=${bw}:${bh}:${padX - bx}:${padY - by}:color=black@0.0${win}[osp${k}]`
        );
      }
      filters.push(`[osp${k}]format=rgba,split[os0${k}][os1${k}]`);
      filters.push(`[os1${k}]alphaextract[osa${k}]`);
      filters.push(`[osa${k}][${matte}]blend=all_mode=multiply[osm${k}]`);
      filters.push(`[os0${k}][osm${k}]alphamerge,format=yuva420p[osc${k}]`);
      filters.push(`[${onto}][osc${k}]overlay=0:0:${enable}:eof_action=pass[${next}]`);
    } else if (keyed) {
      const kpos = posePositionExprs(oc.kf!, oc.start);
      filters.push(
        `[${onto}][${seg}]overlay=x=${kpos.x}:y=${kpos.y}:${enable}:eof_action=pass[${next}]`
      );
    } else {
      filters.push(`[${onto}][${seg}]overlay=${pos}:${enable}:eof_action=pass[${next}]`);
    }
    if (!oc.muted && audioPresence.get(oc.file)) {
      const tempo = ospeed !== 1 ? `${atempoChain(ospeed)},` : "";
      const vol = (oc.volume ?? 1) !== 1 ? `volume=${num(oc.volume ?? 1)},` : "";
      // The picture's fade edges carry the sound with them; zoom edges don't.
      const afades =
        (hf > 0.01 ? `afade=t=in:st=0:d=${num(hf)},` : "") +
        (tf > 0.01 ? `afade=t=out:st=${num(Math.max(0, olen - tf))}:d=${num(tf)},` : "");
      const delayMs = Math.max(0, Math.round(oc.start * 1000));
      const lab = `ovs${k}`;
      filters.push(
        `[${idx}:a]atrim=${num(oc.in)}:${num(oc.out)},asetpts=PTS-STARTPTS,${tempo}${vol}${afades}` +
          `aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${delayMs}:all=1[${lab}]`
      );
      overlaySoundLabels.push(lab);
    }
    return next;
  };

  let vLabel = vAcc;
  for (const oc of overlayVideos) vLabel = addOverlay(oc, vLabel);

  // Burn in overlay elements. Static ones are full-frame PNGs windowed with
  // `enable` (half-open, so back-to-back overlays sharing a boundary never
  // composite on the same frame); animated ones play their region slideshow
  // at the region's own position — the transparent filler covers the rest of
  // the timeline, so no enable window is needed.
  const compositeOverlayEntry = (k: number, onto: string): string => {
    const o = spec.overlays[k];
    const next = `vov${k}`;
    const animIdx = animOverlayInput.get(k);
    if (animIdx !== undefined) {
      if (o.subject && subjectActive && matteConsumers > 0) {
        // Subject-trimmed element: its slideshow pads out to the full frame
        // at its region, the matte multiplies into its alpha, and the
        // trimmed element composites at the origin — in its own lane order,
        // behind (inverted) or on the person alike.
        const matte = nextMatte(`bse${k}`, o.subject);
        filters.push(
          `[${animIdx}:v]fps=${fps},setsar=1,format=rgba,` +
            `pad=${W}:${H}:${num(o.x ?? 0)}:${num(o.y ?? 0)}:color=black@0.0[oep${k}]`
        );
        filters.push(`[oep${k}]split[oe0${k}][oe1${k}]`);
        filters.push(`[oe1${k}]alphaextract[oea${k}]`);
        filters.push(`[oea${k}][${matte}]blend=all_mode=multiply[oem${k}]`);
        filters.push(`[oe0${k}][oem${k}]alphamerge,format=yuva420p[oes${k}]`);
        filters.push(`[${onto}][oes${k}]overlay=0:0:eof_action=pass[${next}]`);
        return next;
      }
      filters.push(`[${animIdx}:v]fps=${fps},format=yuva420p,setsar=1[oanim${k}]`);
      filters.push(
        `[${onto}][oanim${k}]overlay=${num(o.x ?? 0)}:${num(o.y ?? 0)}:eof_action=pass[${next}]`
      );
    } else if (o.file) {
      const idx = inputIndex.get(o.file)!;
      filters.push(
        `[${onto}][${idx}:v]overlay=0:0:enable='gte(t,${num(o.start)})*lt(t,${num(o.end)})'[${next}]`
      );
    } else {
      return onto;
    }
    return next;
  };

  // The element stack, deepest lane first, with the effects standing in it:
  // an effect grades what plays under it, so everything below its lane is
  // composited before its chain runs, and the elements above it land on the
  // graded picture untouched. Each chain is gated to its own window (the shake
  // recipe swaps in a jittered branch through an overlay instead, so nothing
  // else rescales). Subject-tagged elements trim by their matte split inside
  // this walk, in their own lane order.
  const laneOfEntry = (k: number) => spec.overlays[k].lane ?? 0;
  const stacked = spec.overlays
    .map((o, k) => k)
    .sort((a, b) => laneOfEntry(b) - laneOfEntry(a));
  const effects = (spec.effects ?? [])
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (b.e.lane ?? 0) - (a.e.lane ?? 0));
  let placed = 0;
  const compositeDownTo = (lane: number) => {
    while (placed < stacked.length && laneOfEntry(stacked[placed]) > lane) {
      vLabel = compositeOverlayEntry(stacked[placed++], vLabel);
    }
  };
  for (const { e, i } of effects) {
    compositeDownTo(e.lane ?? 0);
    const lines = effectFilterLines(
      vLabel,
      `vfx${i}`,
      e.effect,
      e.amount,
      Math.max(0, e.start),
      Math.min(e.end, spec.duration),
      spec.width,
      spec.height,
      `fx${i}`,
      e.focus,
      e.ramp
    );
    if (!lines) continue;
    filters.push(...lines);
    vLabel = `vfx${i}`;
  }
  compositeDownTo(-Infinity);

  // Subtitle stills ride one concat-demuxer slideshow per track (transparent
  // filler in the gaps), so a karaoke cut with hundreds of word windows still
  // costs one ffmpeg input per language instead of one per still. They sit
  // over every element and every effect.
  captionInputs.forEach((idx, k) => {
    filters.push(`[${idx}:v]fps=${fps},format=yuva420p,setsar=1[caps${k}]`);
    filters.push(`[${vLabel}][caps${k}]overlay=0:0:eof_action=pass[vcaps${k}]`);
    vLabel = `vcaps${k}`;
  });

  // Voiceover ducking: while a ducking clip plays, every other sound drops to
  // its gain. The windows are timeline seconds, so the volume automation must
  // run on timeline-aligned streams — the joined clip audio, and each other
  // sound *after* its adelay.
  const duckWindows = spec.audio
    .filter((a) => a.duck !== undefined && a.duck < 1)
    .map((a) => {
      const speed = a.speed && a.speed > 0 ? a.speed : 1;
      const len = Math.max(0.1, (a.out - a.in) / speed);
      return { from: a.start, to: a.start + len, gain: Math.max(0, a.duck!) };
    });
  // Flatten to non-overlapping segments at the lowest covering gain: chained
  // volume filters multiply, so overlapping voiceovers would otherwise duck
  // deeper than the preview (which takes the minimum).
  const duckSegments = (() => {
    const cuts = [...new Set(duckWindows.flatMap((w) => [w.from, w.to]))].sort((a, b) => a - b);
    const segs: { from: number; to: number; gain: number }[] = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const [from, to] = [cuts[i], cuts[i + 1]];
      const covering = duckWindows.filter((w) => w.from < to && w.to > from);
      if (covering.length === 0) continue;
      const gain = Math.min(...covering.map((w) => w.gain));
      const prev = segs[segs.length - 1];
      if (prev && prev.to === from && prev.gain === gain) prev.to = to;
      else segs.push({ from, to, gain });
    }
    return segs;
  })();
  let duckSeq = 0;
  const duckOthers = (label: string): string => {
    if (duckSegments.length === 0) return label;
    // Half-open windows: between() includes both ends, so adjacent segments
    // would both fire (and multiply) on the exact boundary frame.
    const chain = duckSegments
      .map((w) => `volume=enable='gte(t,${num(w.from)})*lt(t,${num(w.to)})':volume=${num(w.gain)}`)
      .join(",");
    const out = `dk${duckSeq++}`;
    filters.push(`[${label}]${chain}[${out}]`);
    return out;
  };

  // Soundtrack clips: trim, gain, shift into place, mix with clip audio.
  const soundLabels: string[] = [];
  spec.audio.forEach((a, k) => {
    const idx = inputIndex.get(a.file)!;
    if (!audioPresence.get(a.file)) return;
    const speed = a.speed && a.speed > 0 ? a.speed : 1;
    const delayMs = Math.max(0, Math.round(a.start * 1000));
    // Timeline length after any speed change; fade offsets are in these
    // (post-tempo) seconds, so atempo runs before the fades.
    const len = Math.max(0.1, (a.out - a.in) / speed);
    const tempo = speed !== 1 ? `${atempoChain(speed)},` : "";
    const fades: string[] = [];
    if (a.fadeIn && a.fadeIn > 0.01) fades.push(`afade=t=in:st=0:d=${num(a.fadeIn)}`);
    if (a.fadeOut && a.fadeOut > 0.01)
      fades.push(`afade=t=out:st=${num(Math.max(0, len - a.fadeOut))}:d=${num(a.fadeOut)}`);
    filters.push(
      `[${idx}:a]atrim=${num(a.in)}:${num(a.out)},asetpts=PTS-STARTPTS,${tempo}` +
        `aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `volume=${num(a.volume)},` +
        (fades.length ? fades.join(",") + "," : "") +
        `adelay=${delayMs}:all=1[snd${k}]`
    );
    // Music and other non-voiceover sound ducks under the voiceovers.
    soundLabels.push(a.duck !== undefined && a.duck < 1 ? `snd${k}` : duckOthers(`snd${k}`));
  });

  // The joined clip audio and overlay-video audio duck too.
  let aLabel = duckOthers(aAcc);
  const extraSound = [...soundLabels, ...overlaySoundLabels.map(duckOthers)];
  if (extraSound.length > 0) {
    const mixIn = [aLabel, ...extraSound].map((l) => `[${l}]`).join("");
    filters.push(
      `${mixIn}amix=inputs=${extraSound.length + 1}:duration=first:dropout_transition=0:normalize=0[amix]`
    );
    aLabel = "amix";
  }

  // Whole-video fades on the final composite and mix, so titles, captions,
  // overlays, and soundtrack all fade together.
  const fadeIn = projectFadeSeconds(spec.fadeIn, spec.duration);
  const fadeOut = projectFadeSeconds(spec.fadeOut, spec.duration);
  if (fadeIn > 0.01 || fadeOut > 0.01) {
    const win = (f: string) =>
      [
        ...(fadeIn > 0.01 ? [`${f}=t=in:st=0:d=${num(fadeIn)}`] : []),
        ...(fadeOut > 0.01
          ? [`${f}=t=out:st=${num(Math.max(0, spec.duration - fadeOut))}:d=${num(fadeOut)}`]
          : []),
      ].join(",");
    filters.push(`[${vLabel}]${win("fade")}[vfinal]`);
    vLabel = "vfinal";
    filters.push(`[${aLabel}]${win("afade")}[afinal]`);
    aLabel = "afinal";
  }

  const enc = await io.h264Encoder();
  const videoCodecArgs =
    enc === "libx264"
      ? ["-c:v", "libx264", "-preset", spec.preset, "-crf", String(spec.crf)]
      : ["-c:v", "h264_videotoolbox", "-q:v", String(vtQuality(spec.crf)), "-allow_sw", "1"];

  // Encode into the tmp dir, then re-emit the container to strip a stray output
  // rotation flag (see the strip pass below). Keeping the encode intermediate
  // lets the second pass own faststart.
  const encodePath = path.join(job.tmpDir, "encode.mp4");
  await io.runFfmpeg(
    job,
    [
      "-y",
      ...inputs,
      "-filter_complex", filters.join(";"),
      "-map", `[${vLabel}]`,
      "-map", `[${aLabel}]`,
      ...videoCodecArgs,
      "-profile:v", "high",
      "-pix_fmt", "yuv420p",
      "-color_range", "tv",
      "-colorspace", "bt709",
      "-color_primaries", "bt709",
      "-color_trc", "bt709",
      "-c:a", "aac",
      "-b:a", "192k",
      "-t", num(spec.duration),
      encodePath,
    ],
    (t) => (job.progress = Math.min(0.99, t / Math.max(0.1, spec.duration)))
  );

  // ffmpeg's autorotation already baked each source's display matrix into the
  // pixels, so the encode's frames are upright. But for a complex filtergraph it
  // ALSO copies the first input's display-matrix side data onto the output
  // stream — so a phone (portrait) source lands as a correct 1080×1920 file
  // tagged with a stray 90° rotation, and players re-rotate it into a sideways
  // "desktop" frame. `-display_rotation 0` overrides that matrix to identity; a
  // stream copy re-emits the (already correct) pixels and audio unchanged and
  // writes the faststart-optimized final file.
  await io.runFfmpeg(job, [
    "-y",
    "-display_rotation", "0",
    "-i", encodePath,
    "-map", "0",
    "-c", "copy",
    "-movflags", "+faststart",
    job.outPath,
  ]);

  job.progress = 1;
}
