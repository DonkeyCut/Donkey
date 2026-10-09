import { spawn, type ChildProcess } from "node:child_process";
import { exportSourceFiles } from "./sourceExport";
import type { SourceSegment } from "../lib/sourceExportPlan";
import { deliveryCodec, deliveryContainer, deliverySpan, KEYFRAME_INTERVAL_S, videoBitrateFor, type ExportCodec, type ExportRange, type SpecClipColor } from "../lib/exportDelivery";

export type { SpecClipColor };
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { atempoChain, audioChannels, hasStream, mediaDuration, num, videoDecodeCost, videoDimensions, videoPicture } from "./util";
import { SETTINGS, type Settings } from "@/lib/config/registry";
import { xfadeTransition } from "./transitionExpr";
import { assertGraphSafe, fanOutInputs, fexpr } from "./filterGraph";
import { bakeRetimedAudio, setptsExpr, type BakedAudio } from "./retimeAudio";
import { bakeTurnedMedia } from "./turnMedia";
import { withSpecColors } from "./fileColor";
import { alignRecording } from "./soundAlign";
import { shiftSpan, type SpecSound } from "../lib/soundSource";
import { masterRawMix, packStems } from "./exportAudio";
import { STEM_CHANNELS, STEM_RATE, type StemDef } from "../lib/stems";
import { CLIP_MAX_ZOOM, CLIP_MIN_SECONDS, clipFrameAt, regionPx, TRANSITION_ZOOM, type ColorGrade } from "../lib/types";
import { audioFxFilters, buildClipLut, elementLook, buildTransferLut, CLARITY_EPS, compositeSpaceFor, detailActive, detailGain, detailRadius, effectFilterLines, effectRecipe, type FlashRhythm, type FlashTone, type GlitchKind, type LeakCourse, graphicsToHlg, hexToHlgHex, hlgToPq, isAudioEffect, lookFilterLines, lutToCube, mirrorRetimable, parseLutFile, recipeKey, retimeOf, shortestTurn, slowRuns, srcSpan, sortedKeys, soundFilters, type ChainChroma, type ClipColorRecipe, type ClipEffect, type ClipSound, type CodeFormat, type EaseId, type OutputSpace, type OverlayKey, type ParsedLut, type Retime, type SpeedNode } from "@donkeycut/effects-kit";

// The render pipeline itself: spec in, finished mp4 out. Shared by the local
// engine's job registry (jobs.ts) and the cloud render worker, which stage
// media differently but must produce byte-identical renders.

/**
 * One side of a cross dissolve as a volume expression in a stream's own time.
 *
 * The crossing's middle sits on the cut, `half` seconds either side, and the
 * two sides are sine and cosine of the same travel: they meet at 0.707 on the
 * cut, which is where equal power puts a handover that must not dip. Outside
 * the window the expression is 1, so it can ride a stream that is doing other
 * things at its far end. Empty when there is no crossing there.
 */
function crossExpr(cut: number, half: number, rising: boolean): string {
  if (!(half > 0.01)) return "";
  // Parenthesized: a crossing that opens before its stream starts puts a
  // negative number here, and `t--0.5` is not something to hand a parser.
  const p = `clip((t-(${num(cut - half)}))/${num(2 * half)},0,1)`;
  return `${rising ? "sin" : "cos"}(${p}*PI/2)`;
}

/** A split edit's ramp as a `volume` factor over its stream: the stretch
 * `[from, from + len]` past the picture, opening from silence over `fade`
 * at its start (a lead) or closing to silence over `fade` at its end (a
 * tail); 1 everywhere else. */
function splitExpr(from: number, len: number, fade: number, opening: boolean): string {
  const f = Math.min(fade, len);
  if (!(f > 0.0005)) return "";
  return opening
    ? `clip((t-(${num(from)}))/${num(f)},0,1)`
    : `clip(((${num(from + len)})-t)/${num(f)},0,1)`;
}

/** The expressions folded into one `volume` filter, quoted so the graph
 * parser carries their commas whole.
 *
 * `volume` re-evaluates once a frame, and a default frame is 23 ms — coarse
 * enough for a half-second ramp to move in audible steps. Short frames first
 * (unpadded, so the stream keeps its exact length) put the steps under 6 ms,
 * where the ramp reads as a ramp. */
function crossFilters(exprs: string[]): string {
  const live = exprs.filter(Boolean);
  if (live.length === 0) return "";
  return `,asetnsamples=n=256:p=0,volume=volume=${fexpr(live.join("*"))}:eval=frame`;
}

/** A clip's own sound treatment as a chain fragment ending in a comma, or
 * nothing: spliced into the clip's stanza ahead of its level, fades and
 * crossings — where the preview's voice and the browser fold run it too. */
const soundChain = (sound: ClipSound | undefined): string => {
  const chain = soundFilters(sound);
  return chain ? `${chain},` : "";
};

export interface ExportSpec {
  sourceSegments?: SourceSegment[];
  projectId: string;
  /** The delivery's color space; absent = SDR. */
  colorSpace?: OutputSpace;
  /** Lattice nodes per axis of the clip color LUTs: `lutSize` for Rec.709
   * and sRGB sources, `lutSizeWide` for log and HDR. */
  lutSize?: number;
  lutSizeWide?: number;
  /** The memory one encode pass may hold and the most pieces it opens;
   * absent = the setting's default. */
  passes?: Settings["cutExportPasses"];
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
  /** The delivery. A spec from before these existed is an H.264 + AAC MP4. */
  codec?: ExportCodec;
  container?: "mp4" | "mov";
  audioCodec?: "aac" | "pcm";
  audioBitrate?: number;
  audioSampleRate?: number;
  audioChannels?: number;
  /** A bitrate the user typed, bits per second; absent = the `crf` tier. */
  bitrate?: number;
  /** The file's name without its extension, as typed; absent = the project's
   * name. */
  name?: string;
  /** The stretch of the timeline to deliver, seconds; absent = all of it. The
   * graph composites the whole cut and the delivery is cut from it, so fades,
   * captions and elements sit where the timeline has them. */
  range?: ExportRange;
  /** The integrated loudness the delivered mix is mastered to, LUFS; absent
   * = the mix as it plays. */
  loudness?: number;
  /** The true peak a mastered mix is held under, dBTP. */
  truePeakCeiling?: number;
  /** The stems written beside the file, zipped at the handle's
   * `stemsPath`; absent = none. */
  stemPlan?: StemDef[];
  duration: number;
  /** The frame's own color (hex): what letterboxes a fitted clip, what a gap
   * on track 0 plays, and what a cut of nothing but elements composites over.
   * Absent = black. */
  background?: string;
  clips: {
    file: string;
    in: number;
    out: number;
    muted: boolean;
    /** Gain on the clip's own audio, 0..3; absent = 1 (unchanged). */
    volume?: number;
    /** The clip's own sound treatment — the kit builds the chain from it. */
    sound?: ClipSound;
    /** "fit" letterboxes (default); "fill" covers the region and crops. */
    fit?: "fit" | "fill";
    /** How far the picture zooms past the size its box fits it to (1 = none).
     * Whatever the zoom pushes outside the box is cropped. */
    zoom?: number;
    panX?: number; // crop-window pan -1..1, across whatever overflows
    panY?: number;
    /** Mirror the framed picture left for right / top for bottom. */
    flipH?: boolean;
    flipV?: boolean;
    /** Region of the frame this clip fills; absent = full frame. */
    frame?: { x: number; y: number; w: number; h: number };
    speed?: number; // playback rate, default 1
    /** A rate that changes through the footage: [source second, rate] nodes
     * (see retimeOf); present, `speed` is ignored. */
    speedCurve?: SpeedNode[];
    reverse?: boolean;
    /** Synthesize the frames wherever the rate runs below 1× (see slowRuns). */
    smoothSlow?: boolean;
    /** Transition into the next clip, in timeline seconds (overlap). */
    transition?: number;
    /** Half the cross dissolve into the next clip, in timeline seconds: the
     * picture cuts while the two clips ramp equal-power past each other over
     * that long either side of it. Carried apart from `transition` so a join
     * that blends only the sound is not read as a picture blend anywhere. */
    soundCross?: number;
    /** Source seconds past `out` this clip keeps sounding into the crossing
     * at its tail, and source seconds before `in` it starts sounding for the
     * crossing at its head — the handles that let both clips be audible over
     * a cut their pictures hard-join. */
    soundAhead?: number;
    soundBack?: number;
    /** A split edit: seconds of `soundBack` the sound plays ahead of the
     * picture (J-cut) and of `soundAhead` it carries past it (L-cut), each
     * ramping from silence over `splitFade` at its far end. */
    soundLead?: number;
    soundTail?: number;
    splitFade?: number;
    /** The recording bound to this clip's video, which its sound reads in
     * place of the file's own track (see soundAlign.ts). */
    soundFrom?: SpecSound;
    /** Transition look id, resolved to an xfade name through the
     * TRANSITION_XFADE allowlist (unknown ids render as a plain fade). Cross
     * zoom renders as the fade plus zoom ramps on both segments' overlap
     * windows. */
    transitionStyle?: string;
    /** Softness of that transition's reveal edge (lib/transitionShape.ts);
     * absent = hard. */
    transitionFeather?: number;
    /** This clip's own entrance/exit animation, baked into the segment's
     * head/tail window: fade (audio follows), zoom, pop, or a slide
     * against black. Unknown styles render as a fade. */
    animIn?: { style: string; seconds: number };
    animOut?: { style: string; seconds: number };
    /** Preset filter look id + strength 0..1, baked into the segment (the
     * spec carries only the id — the chain is built server-side). */
    look?: string;
    lookAmount?: number;
    /** Effects the clip wears over its own picture, on its own clock. */
    effects?: ClipEffect[];
    /** Seconds that clock has run at the clip's first frame. */
    effectsFrom?: number;
    /** Hidden clips keep their slot but render black + silent. */
    hidden?: boolean;
    /** A still image: looped for the clip's length instead of trimmed. */
    image?: boolean;
    /** The picture travels with the job rather than living in the project's
     * media: a block, painted client-side, staged in `tmpDir` by base name
     * like the overlay pictures. */
    staged?: boolean;
    /** Manual color adjustments, baked into this clip's segment. */
    grade?: ColorGrade;
    /** The source's color, which the grade is built over. Absent = Rec.709. */
    color?: SpecClipColor;
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
    kf?: OverlayKey[];
    /** Motion blur shutter, 0..1 of a 30fps frame, streaking the keyed
     * movement; absent = off. Key blur and the streak soften the posed
     * segment frame by frame. */
    motionBlur?: number;
    /** Client-painted border ring (a stroked rounded rect along the clip's
     * box, transparent elsewhere), full-frame sized; overlaid onto the
     * segment before fades, masks and pose so it rides the clip. */
    border?: string;
    /** Client-painted drop shadow: the clip's own silhouette blurred, thrown,
     * and punched back out, full-frame sized. It goes down last — a mask would
     * otherwise trim away the very ink that lies outside the shape — and a
     * clip that moves ships it as a `frames` sequence like a keyframed mask. */
    shadow?: {
      file?: string;
      frames?: { file: string; duration: number }[];
    };
    /** Background removal: the clip's keyed layer, client-rendered as a
     * segment-aligned color/alpha video pair (grade, key, stroke ink and
     * backdrop baked in, straight alpha colors). The pair replaces the source
     * decode for the picture; audio still reads the original file, and the
     * look applies to the flattened segment. */
    removal?: { rgb: string; alpha: string };
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
    /** How far the picture zooms past the size its box fits it to (1 = none). */
    zoom?: number;
    panX?: number; // crop-window pan -1..1, across whatever overflows
    panY?: number;
    /** Mirror the framed picture left for right / top for bottom. */
    flipH?: boolean;
    flipV?: boolean;
    muted: boolean;
    /** Gain on the clip's own audio, 0..3; absent = 1 (unchanged). */
    volume?: number;
    sound?: ClipSound;
    speed?: number;
    /** A rate that changes through the footage: [source second, rate] nodes
     * (see retimeOf); present, `speed` is ignored. */
    speedCurve?: SpeedNode[];
    reverse?: boolean;
    /** Synthesize the frames wherever the rate runs below 1× (see slowRuns). */
    smoothSlow?: boolean;
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
    /** Half the cross dissolve at this overlay's head/tail, timeline seconds:
     * the level crosses equal-power at the cut and the picture is left alone.
     * `soundBack`/`soundAhead` are the handle each side reaches into so both
     * clips are really sounding through the crossing. */
    headSound?: number;
    tailSound?: number;
    soundBack?: number;
    soundAhead?: number;
    /** A split edit and a bound recording, as on `clips`. */
    soundLead?: number;
    soundTail?: number;
    splitFade?: number;
    soundFrom?: SpecSound;
    /** A still image: looped for the clip's length instead of trimmed. */
    image?: boolean;
    /** Manual color adjustments, baked into this overlay's segment. */
    grade?: ColorGrade;
    /** The source's color, which the grade is built over. Absent = Rec.709. */
    color?: SpecClipColor;
    /** Preset filter look id + strength (footage overlays only — image
     * overlays may carry alpha the look chain would flatten). */
    look?: string;
    lookAmount?: number;
    /** Effects the clip wears over its own picture, under its mask. */
    effects?: ClipEffect[];
    /** Seconds that clock has run at the clip's first frame. */
    effectsFrom?: number;
    /** Client-painted grayscale coverage trimming this overlay's picture,
     * box-sized (a letterboxed segment pads out to its box when masked);
     * `subject` trims by the shared person matte instead. */
    mask?: {
      file?: string;
      frames?: { file: string; duration: number }[];
      subject?: { invert?: boolean; feather?: number };
    };
    /** Keyframed pose track, seconds from this overlay's start. */
    kf?: OverlayKey[];
    /** Motion blur shutter, as on `clips`. */
    motionBlur?: number;
    /** Client-painted border ring, box-sized (a letterboxed segment pads out
     * to its box when bordered); overlaid onto the segment so it rides the
     * clip through fades, masks and pose. */
    border?: string;
    /** Client-painted drop shadow, full-frame sized: laid over the frame just
     * before the clip goes down, so it falls on the tracks beneath it. */
    shadow?: {
      file?: string;
      frames?: { file: string; duration: number }[];
    };
    /** Background removal, as on `clips`; this layer keeps its alpha over the
     * tracks beneath, so grade and look are both baked into the pair. */
    removal?: { rgb: string; alpha: string };
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
    /** A rate that changes through the footage: [source second, rate] nodes
     * (see retimeOf); present, `speed` is ignored. */
    speedCurve?: SpeedNode[];
    reverse?: boolean;
    sound?: ClipSound;
    /** Voiceover ducking: while this clip plays, every other sound drops to
     * this gain (0..1). Ducking clips never duck each other. */
    duck?: number;
    /** Detached from a video bound to a recording: it plays the recording. */
    soundFrom?: SpecSound;
    /** The soundtrack lane it sits on, which picks its stem; absent = 0. */
    lane?: number;
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
   * LGPL-safe chains are built here from the kit's recipes. A picture effect
   * grades what plays under it: the video, the overlay tracks, and every
   * element on a lane below its own. An audio effect treats the finished mix
   * over its window instead, and takes no lane. */
  effects?: {
    effect: string;
    amount?: number;
    focus?: { x: number; y: number };
    /** Seconds a zoom takes to reach its depth. */
    ramp?: number;
    /** A light leak's course. */
    leak?: LeakCourse;
    /** The kind a glitch is pinned to. */
    glitch?: GlitchKind;
    /** A flash's tone, strobe rate and rhythm. */
    tone?: FlashTone;
    rate?: number;
    rhythm?: FlashRhythm;
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

/** The rate the graph mixes at: every read resamples to it. */
const MIX_RATE = 44100;

/** What the pipeline needs from its caller's job record: the staging dir the
 * overlay PNGs were written into, the output path, and the mutable fields the
 * run reports through (progress, the live ffmpeg process for cancellation,
 * the rolling stderr log, and an externally-set error that wins over the
 * generic exit message). The engine's Job and the worker's claimed row both
 * satisfy it structurally. */
export interface RenderHandle {
  tmpDir: string;
  outPath: string;
  /** Where the stems zip lands when the spec asks for stems. */
  stemsPath?: string;
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
/** The encoders this machine's ffmpeg carries, read once. An ffmpeg that
 * cannot be asked answers empty, and the picks below then fall to the names
 * the Mac's bundled build has. */
let encodersCache: Promise<Set<string>> | null = null;
function ffmpegEncoders(): Promise<Set<string>> {
  return (encodersCache ??= new Promise((resolve) => {
    let out = "";
    const proc = spawn("ffmpeg", ["-hide_banner", "-encoders"]);
    proc.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    proc.on("error", () => resolve(new Set()));
    proc.on("close", () =>
      resolve(new Set(out.split("\n").map((l) => l.trim().split(/\s+/)[1]).filter(Boolean)))
    );
  }));
}

export async function h264Encoder(): Promise<"libx264" | "h264_videotoolbox"> {
  return (await ffmpegEncoders()).has("libx264") ? "libx264" : "h264_videotoolbox";
}

export type ExportVideoCodec = NonNullable<ExportSpec["codec"]>;

/**
 * The ffmpeg encoder for a delivery codec: the software one where the build
 * has it (the worker's Debian ffmpeg), VideoToolbox on the Mac's LGPL build,
 * and ffmpeg's own ProRes writer, which every build carries.
 */
export async function videoEncoder(codec: ExportVideoCodec): Promise<string> {
  const have = await ffmpegEncoders();
  if (codec === "prores" || codec === "prores4444") return "prores_ks";
  if (codec === "hevc") return have.has("libx265") ? "libx265" : "hevc_videotoolbox";
  return have.has("libx264") ? "libx264" : "h264_videotoolbox";
}

/** VideoToolbox constant quality (1–100, higher = better) from the CRF knob a
 * fixed-quality convert carries (lower CRF = better). Maps 19/24/30 to
 * ~66/57/46. */
export function vtQuality(crf: number) {
  return Math.round(Math.max(35, Math.min(80, 100 - crf * 1.8)));
}

/**
 * The bitrate an export's quality choice asks for at these dimensions, in bits
 * per second: H.264 bits-per-pixel halving every +6 CRF from a ~0.08 bpp anchor
 * at CRF 23.
 *
 * VideoToolbox is what the bundled ffmpeg has — the LGPL build carries no
 * libx264 — and it has neither CRF nor `-preset`. Handed `-q:v`, the quality
 * knob folded the whole preset range into a few points of constant quality:
 * every choice in the export dialog rendered at the same size and took the same
 * time, so picking "Quick share" gave back the "Best" file. A bitrate target
 * keeps the choice meaningful, and `videoBitrateFor` is the same model the
 * dialog quotes its size estimate from, so the file matches what the user was
 * shown.
 */
export function targetBitrate(width: number, height: number, fps: number, crf: number, codec: ExportVideoCodec = "h264") {
  return videoBitrateFor({ width, height, fps, crf, codec });
}

/**
 * The encoder's own arguments for a spec's delivery: the codec, its rate
 * control, the pixel format and profile players expect of it, and for HEVC the
 * `hvc1` tag QuickTime requires. ffmpeg's ProRes writer has one quality per
 * profile, so the tier and bitrate do not reach it.
 */
export function videoCodecArgs(enc: string, spec: ExportSpec): string[] {
  const codec = spec.codec ?? "h264";
  const hdr = (spec.colorSpace ?? "sdr") !== "sdr";
  const bitrate = videoBitrateFor({ ...spec, codec });
  const rate = ["-b:v", String(bitrate), "-maxrate", String(Math.round(bitrate * 1.5)), "-bufsize", String(bitrate * 3)];
  // A key frame every two seconds, the cadence the platforms ask for and the
  // one the tab's encoder writes.
  const gop = ["-g", String(Math.max(1, Math.round(spec.fps * KEYFRAME_INTERVAL_S)))];
  // The HEVC bitstream's own color signalling, written into its VUI whatever
  // the encoder put there: Rec.2020 primaries (9), the HLG (18) or PQ (16)
  // transfer, the Rec.2020 non-constant matrix (9), limited range.
  const hevcVui = hdr
    ? ["-bsf:v", `hevc_metadata=colour_primaries=9:transfer_characteristics=${spec.colorSpace === "pq" ? 16 : 18}:matrix_coefficients=9:video_full_range_flag=0`]
    : [];
  switch (enc) {
    case "libx264":
      if (hdr) throw new Error("H.264 is 8-bit. Export HDR as HEVC or ProRes.");
      return ["-c:v", "libx264", "-preset", spec.preset, ...(spec.bitrate ? rate : ["-crf", String(spec.crf)]), ...gop, "-profile:v", "high", "-pix_fmt", "yuv420p"];
    case "h264_videotoolbox":
      if (hdr) throw new Error("H.264 is 8-bit. Export HDR as HEVC or ProRes.");
      return ["-c:v", "h264_videotoolbox", ...rate, ...gop, "-profile:v", "high", "-pix_fmt", "yuv420p", "-allow_sw", "1"];
    case "libx265": {
      // x265's CRF scale sits about four points above x264's for the same picture.
      // An HDR file is Main 10 with its color in the stream; a PQ file also
      // carries HDR10 static metadata — the Rec.2020 mastering display at
      // 1000 nits and the content light it implies — which players read for
      // their tone mapping.
      const params = hdr
        ? [
            "log-level=error",
            "colorprim=bt2020",
            `transfer=${spec.colorSpace === "pq" ? "smpte2084" : "arib-std-b67"}`,
            "colormatrix=bt2020nc",
            "range=limited",
            ...(spec.colorSpace === "pq"
              ? ["hdr10=1", "hdr10-opt=1", "master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)", "max-cll=1000,400"]
              : []),
          ].join(":")
        : "log-level=error";
      return ["-c:v", "libx265", "-preset", spec.preset, ...(spec.bitrate ? rate : ["-crf", String(spec.crf + 4)]), ...gop, "-x265-params", params, "-tag:v", "hvc1", "-pix_fmt", hdr ? "yuv420p10le" : "yuv420p", ...(hdr ? ["-profile:v", "main10"] : []), ...hevcVui];
    }
    case "hevc_videotoolbox":
      // Main 10 takes its 10-bit planes as p010; the color signalling rides
      // the stream's own tags and the VUI rewrite. A PQ file from this Mac
      // carries no static metadata: players take the 1000-nit reference.
      return hdr
        ? ["-c:v", "hevc_videotoolbox", ...rate, ...gop, "-profile:v", "main10", "-tag:v", "hvc1", "-pix_fmt", "p010le", "-allow_sw", "1", ...hevcVui]
        : ["-c:v", "hevc_videotoolbox", ...rate, ...gop, "-profile:v", "main", "-tag:v", "hvc1", "-pix_fmt", "yuv420p", "-allow_sw", "1"];
    case "prores_ks": {
      // Profile 3 is 422 HQ, profile 4 is 4444. 4444 keeps the chroma the
      // graph composited at — every pixel its own color, which is what the
      // titles, captions and stickers drawn in RGBA were made of — and the
      // alpha-free pixel format spares the file a plane that is all opaque.
      const full = codec === "prores4444";
      return ["-c:v", "prores_ks", "-profile:v", full ? "4" : "3", "-vendor", "apl0",
        "-pix_fmt", full ? "yuv444p10le" : "yuv422p10le"];
    }
    default:
      throw new Error(`No encoder for ${codec}.`);
  }
}

/** The color tags a delivered file carries, container and stream alike:
 * BT.709 for SDR; Rec.2020 primaries and matrix with the HLG or PQ transfer
 * for HDR. */
export function colorTagArgs(spec: Pick<ExportSpec, "colorSpace">): string[] {
  const space = spec.colorSpace ?? "sdr";
  if (space === "sdr") return ["-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];
  return ["-color_range", "tv", "-colorspace", "bt2020nc", "-color_primaries", "bt2020", "-color_trc", space === "pq" ? "smpte2084" : "arib-std-b67"];
}

/** The same signalling stamped on the finished frames. The MOV muxer writes
 * ProRes's colr atom from what the frames carry, and the encoder options
 * alone leave that file untagged. */
export function colorParamsFilter(spec: Pick<ExportSpec, "colorSpace">): string {
  const space = spec.colorSpace ?? "sdr";
  if (space === "sdr") return "setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709";
  return `setparams=range=tv:colorspace=bt2020nc:color_primaries=bt2020:color_trc=${space === "pq" ? "smpte2084" : "arib-std-b67"}`;
}

/** The audio arguments for a spec's delivery. */
export function audioCodecArgs(spec: ExportSpec): string[] {
  return [...(spec.audioCodec === "pcm" ? ["-c:a", "pcm_s16le"] : ["-c:a", "aac", "-b:a", String(spec.audioBitrate ?? 192_000)]),
    ...(spec.audioSampleRate ? ["-ar", String(spec.audioSampleRate)] : []),
    ...(spec.audioChannels ? ["-ac", String(spec.audioChannels)] : [])];
}

/** The file extension a spec's container takes. */
export function containerExtension(spec: Pick<ExportSpec, "container">): string {
  return deliveryContainer(spec.container).ext;
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

/** A clip's effective playback rate (>0, default 1). */
/** A spec color as an ffmpeg color argument: `0xRRGGBB`. Anything the spec
 * did not carry, or carried malformed, is black — the frame every cut had
 * before the project could choose one. */
function ffColor(hex: string | undefined): string {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? "").trim());
  return m ? `0x${m[1].toUpperCase()}` : "black";
}

/** The `setpts` that lays a trimmed span at its rate: the plain division for
 * one rate, the map's polyline for a curve (quoted: it carries commas). */
/** The longest a source frame may stay on screen: footage runs at 1 fps or
 * more, so a trim reaching this far before the in point keeps the frame
 * already showing there. */
const SOURCE_PREROLL = 1;

/** A footage clip's source span, timed from its in point: the frame on
 * screen at the in point comes along (stamped before 0) and the re-stamp to
 * the output rate shows it on the clip's first frame. */
const sourceSpan = (idx: number, c: { in: number; out: number }, rt: Retime) =>
  `[${idx}:v]trim=${num(Math.max(0, c.in - SOURCE_PREROLL))}:${num(c.out)},setpts=${retimedPts(rt, c.in)}`;

/** A curve clamps everything before its first knot to 0; the preroll keeps
 * its own seconds before 0, as one rate does, so a trim at 0 drops it. */
const retimedPts = (rt: Retime, from: number) =>
  rt.uniform
    ? `(PTS-${num(from)}/TB)/${num(rt.rate)}`
    : fexpr(`${setptsExpr(rt, from)}+min(T-${num(from)},0)/TB`);

/** Timeline length of a media clip's span through its rate or curve. */
/** ffmpeg's motion-compensated interpolation, laying `fps` frames over the
 * sparse ones a slowed span has: bidirectional block motion estimation and
 * overlapped-block compensation, with its scene-change guard on so a cut
 * inside the footage is never blended across. */
const MOTION_INTERPOLATE = "mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:scd=fdiff";

/** Footage re-stamped to the output rate from 0: each output frame shows the
 * last source frame that has started by its time, as the preview's decoder
 * does. A 25 fps source at 30 fps holds its first frame twice. */
const sourceAt = (fps: number) => `fps=${fps}:round=up:start_time=0`;

/**
 * The head of a footage clip's picture chain: its retimed, framed source at
 * `fps`. A clip smoothing its slow motion runs ffmpeg's motion interpolation
 * over exactly the stretches its rate is under 1× — the span is cut into
 * pieces at those boundaries, each piece re-stamped to `fps` on its own
 * (interpolated or plain), and the pieces joined back — so a curve that
 * dips and races past 1× is smoothed in the dip alone. The framing runs
 * first, so the estimate works at the output size on the frames the slow
 * stretch actually has.
 */
function framedTimebase(
  timebase: string,
  framing: string,
  tag: string,
  c: { smoothSlow?: boolean; image?: boolean },
  rt: Retime,
  fps: number,
  filters: string[]
): string {
  const plain = `${timebase},${sourceAt(fps)},${framing},setsar=1`;
  if (c.image || !c.smoothSlow) return plain;
  const runs = slowRuns(rt, 1 / fps);
  if (runs.length === 0) return plain;
  const interp = `minterpolate=fps=${fps}:${MOTION_INTERPOLATE}`;
  // Interpolation starts on the first frame at or after the in point.
  const framed = `${timebase},trim=start=0,${framing},setsar=1`;
  if (runs.length === 1 && runs[0][0] <= 1e-6 && runs[0][1] >= rt.len - 1e-6) {
    return `${framed},${interp}`;
  }
  const pieces: { from: number; to: number; slow: boolean }[] = [];
  let at = 0;
  for (const [from, to] of runs) {
    if (from > at + 1e-6) pieces.push({ from: at, to: from, slow: false });
    pieces.push({ from, to, slow: true });
    at = to;
  }
  if (rt.len > at + 1e-6) pieces.push({ from: at, to: rt.len, slow: false });
  filters.push(`${framed},split=${pieces.length}${pieces.map((_, k) => `[smi${tag}_${k}]`).join("")}`);
  pieces.forEach((pc, k) => {
    filters.push(
      `[smi${tag}_${k}]trim=${num(pc.from)}:${num(pc.to)},setpts=PTS-STARTPTS,${pc.slow ? interp : sourceAt(fps)}[smo${tag}_${k}]`
    );
  });
  filters.push(
    `${pieces.map((_, k) => `[smo${tag}_${k}]`).join("")}concat=n=${pieces.length}:v=1:a=0,fps=${fps}[smo${tag}]`
  );
  return `[smo${tag}]null`;
}

/** Concat-list times are kept to the microsecond. */
const CONCAT_US = 1e6;

/** A window edge in seconds, to the microsecond: a time floored to the
 * tenth of a millisecond still opens on the frame it sits just under. */
const edge = (t: number) => t.toFixed(6);

/**
 * An ffconcat slideshow of pictures laid end to end from 0, each held until
 * its `to` second. Every duration is the gap between two microsecond-rounded
 * ends, so a long run of one-frame pictures never drifts off the timeline.
 * A picture whose end does not move past the one before is left out. Each
 * picture opens at the output rate: the demuxer stamps the slideshow in its
 * first picture's timebase, and a still's default of 25 fps would round
 * every start to 40 ms and drop one 30 fps picture in five.
 */
function concatList(holds: { file: string; to: number }[], fps: number): string {
  const lines = ["ffconcat version 1.0"];
  let at = 0;
  for (const h of holds) {
    const end = Math.round(h.to * CONCAT_US);
    if (end <= at) {
      continue;
    }
    lines.push(`file '${h.file}'`, `option framerate ${fps}`, `duration ${((end - at) / CONCAT_US).toFixed(6)}`);
    at = end;
  }
  return lines.join("\n") + "\n";
}

/** How far past a whole frame a time may sit, in frames, and still count as
 * on it: rounding in a sum of clip lengths never pushes a cut a frame late. */
const GRID_SLACK = 1e-3;

/** The first output frame at or after `t` seconds. */
const gridFrame = (t: number, fps: number) => Math.ceil(t * fps - GRID_SLACK);

/** Filters that hold a stream to exactly `count` frames at `fps`: a short
 * one repeats its last frame, a long one is cut. */
const gridHold = (count: number, fps: number) =>
  `tpad=stop_mode=clone:stop=${count},trim=end_frame=${count},setpts=PTS-STARTPTS,fps=${fps}`;

const spanLen = (c: { in: number; out: number; speed?: number; speedCurve?: SpeedNode[]; reverse?: boolean }) =>
  Math.max(CLIP_MIN_SECONDS, retimeOf(c).len);

/** Seconds a range keeps on either side of itself beyond what a join or a
 * sound handle reaches, so a boundary never lands on a frame the neighbor
 * still shapes. */
const RANGE_SLACK_S = 0.5;

/** Source seconds a file's input opens ahead of the earliest read the graph
 * makes of it, and the earliest it seeks to at all: a file read from near
 * its start opens as it is. The seek lands on a whole second, a point on
 * every sample and frame grid. */
const READ_MARGIN_S = 1;
const READ_SEEK_MIN_S = 10;

/**
 * How far before and after its slot each track-0 clip shapes the delivery:
 * its own sound handles, the join and sound crossing at each of its cuts, and
 * a neighbor's edge animation that plays over its held frame. A 1 s join
 * into clip j reaches 1 s back from j's start; a 1.3 s entrance on clip j
 * reaches 1.3 s past clip j-1's end.
 */
function clipReach(spec: ExportSpec): { before: number; after: number }[] {
  return spec.clips.map((c, j) => {
    const prev = spec.clips[j - 1];
    const next = spec.clips[j + 1];
    return {
      before: Math.max(c.soundBack ?? 0, prev?.transition ?? 0, prev?.soundCross ?? 0, prev?.animOut?.seconds ?? 0),
      after: Math.max(c.soundAhead ?? 0, c.soundCross ?? 0, next?.animIn?.seconds ?? 0),
    };
  });
}

/**
 * Frames each piece of a pass holds: every piece's input is primed when the
 * graph opens and its chain keeps frames through the encode, about this many
 * of its source's size or the delivery's, whichever is larger. Cuts played
 * out of file order add the frames their decoder holds until their turn. The
 * pass budget (the cutExportPasses setting) caps their sum and the count.
 */
const PIECE_FRAMES = 16;

/** A source's decoded picture: its size in pixels and its frame rate. */
export type SourcePicture = { pixels: number; fps: number };

/** A piece of one window: its timeline span and, for footage, the file and
 * the source seconds its picture reads. */
type PassSpan = { start: number; end: number; before: number; after: number; file: string; lo?: number; hi?: number };

/**
 * Seconds of source a file's one decoder holds at most for the window's cuts
 * still to come. The decoder reads each file forward once and the join takes
 * cuts in timeline order, so a cut that sits later in the timeline than in the
 * file waits as frames until its turn. Cuts read in file order hold nothing:
 * 0–2, 5–7, 9–11 hold 0 s; 9–11, 0–2, 5–7 hold the 4 s of 0–2 and 5–7 the
 * decoder passes on its way to 11.
 */
function heldSeconds(cuts: PassSpan[]): number {
  const order = [...cuts].sort((x, y) => x.start - y.start);
  let reached = -Infinity;
  let most = 0;
  for (const [i, cut] of order.entries()) {
    reached = Math.max(reached, cut.hi!);
    const held = order.slice(i + 1).reduce((sum, c) => sum + Math.max(0, Math.min(c.hi!, reached) - c.lo!), 0);
    most = Math.max(most, held);
  }
  return most;
}

/**
 * The delivery cut into the windows it renders in, one pass each: every
 * window touches at most the budget's pieces, and their primed frames plus the
 * frames its decoders hold for cuts out of file order stay within its memory
 * (with the reach a range keeps); each window ends on a frame at a piece's
 * start. `sourceOf` is a file's decoded picture. A delivery under the budget
 * is one window. Each pass is a range export, so its frames and samples are
 * the ones the whole composite has there, and the windows laid end to end
 * are the delivery.
 */
export function passWindows(spec: ExportSpec, sourceOf: (file: string) => SourcePicture): ExportRange[] {
  const budget = spec.passes ?? SETTINGS.cutExportPasses.default;
  const from = Math.max(0, spec.range?.start ?? 0);
  const to = Math.min(spec.duration, spec.range?.end ?? spec.duration);
  const frameBytes = (file: string) => 1.5 * Math.max(sourceOf(file).pixels, spec.width * spec.height);

  // Every piece the graph builds a chain for, as a timeline span, with the
  // source a footage piece's picture reads.
  const spans: PassSpan[] = [];
  const footage = (c: Parameters<typeof retimeOf>[0] & { file: string; image?: boolean }): Pick<PassSpan, "lo" | "hi"> => {
    if (c.image || !c.file) {
      return {};
    }
    const rt = retimeOf(c);
    const { lo, hi } = srcSpan(rt, 0, rt.len);
    return { lo: Math.max(0, lo - SOURCE_PREROLL), hi };
  };
  const reach = clipReach(spec);
  let cursor = 0;
  for (const [j, c] of spec.clips.entries()) {
    spans.push({ start: cursor, end: cursor + spanLen(c), ...reach[j], file: c.file, ...footage(c) });
    cursor += spanLen(c);
  }
  for (const o of spec.overlayVideos ?? []) {
    const handles = { before: o.soundBack ?? 0, after: o.soundAhead ?? 0 };
    spans.push({ start: o.start, end: o.start + spanLen(o), ...handles, file: o.file, ...footage(o) });
  }
  for (const o of spec.overlays) {
    spans.push({ start: o.start, end: o.end, before: 0, after: 0, file: "" });
  }

  // A window fits when its pieces' primed frames and its decoders' waiting
  // ones come in under the budget.
  const fits = (a: number, b: number) => {
    const held = spans.filter((s) => s.end + s.after >= a - RANGE_SLACK_S && s.start - s.before <= b + RANGE_SLACK_S);
    if (held.length > budget.pieces) {
      return false;
    }
    let bytes = held.reduce((sum, s) => sum + PIECE_FRAMES * frameBytes(s.file), 0);
    for (const file of new Set(held.filter((s) => s.lo !== undefined).map((s) => s.file))) {
      const cuts = held.filter((s) => s.file === file && s.lo !== undefined);
      bytes += heldSeconds(cuts) * sourceOf(file).fps * frameBytes(file);
    }
    return bytes <= budget.holdMB * 1024 * 1024;
  };

  // Window edges sit on whole frames at piece starts, so each pass's trim
  // takes exactly the frames between two edges.
  const edges = [...new Set(spans.map((s) => gridFrame(s.start, spec.fps) / spec.fps))]
    .filter((t) => t > from && t < to)
    .sort((a, b) => a - b);

  // Each window runs to the furthest edge that keeps it within the budget; a
  // window whose first edge is already over still ends there.
  const windows: ExportRange[] = [];
  let start = from;
  while (!fits(start, to)) {
    const next = edges.filter((t) => t > start);
    if (next.length === 0) {
      break;
    }
    let end = next[0];
    for (const t of next) {
      if (!fits(start, t)) {
        break;
      }
      end = t;
    }
    windows.push({ start, end });
    start = end;
  }
  windows.push({ start, end: to });
  return windows;
}

/**
 * The spec with everything that cannot reach the range taken out of the
 * graph's way: a track-0 clip whose slot ends before the range or starts
 * after it is hidden — the slot keeps its length as a bare frame, so nothing
 * shifts, and its file is never decoded, scaled, or graded — and the entries
 * placed at absolute times (layers, sound, elements, captions, effects) are
 * dropped when they lie wholly outside. A clip is kept while any join or
 * sound handle it takes part in can still reach the range. A spec with no
 * range is returned as it is.
 */
export function narrowSpecToRange(spec: ExportSpec): ExportSpec {
  if (!spec.range) return spec;
  const reach = clipReach(spec);
  const from = Math.max(0, spec.range.start) - RANGE_SLACK_S;
  const to = Math.min(spec.duration, spec.range.end) + RANGE_SLACK_S;
  const inside = (start: number, end: number) => end >= from && start <= to;
  let cursor = 0;
  const clips = spec.clips.map((c, j) => {
    const start = cursor;
    const end = cursor + spanLen(c);
    cursor = end;
    return c.hidden || inside(start - reach[j].before, end + reach[j].after) ? c : { ...c, hidden: true };
  });
  return {
    ...spec,
    clips,
    ...(spec.overlayVideos
      ? {
          overlayVideos: spec.overlayVideos.filter((o) =>
            inside(o.start - (o.soundBack ?? 0), o.start + spanLen(o) + (o.soundAhead ?? 0))
          ),
        }
      : {}),
    audio: spec.audio.filter((a) => inside(a.start, a.start + spanLen(a))),
    overlays: spec.overlays.filter((o) => inside(o.start, o.end)),
    ...(spec.captions ? { captions: spec.captions.filter((c) => inside(c.start, c.end)) } : {}),
    ...(spec.effects ? { effects: spec.effects.filter((e) => inside(e.start, e.end)) } : {}),
  };
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

/** End a render whose job was canceled or timed out between passes. */
function stopIfCanceled(job: RenderHandle) {
  if (job.error) throw new Error(job.error);
}

/** The pipeline's edges into the world: staged-media checks, list-file
 * writes, stream probes, the encoder probe, and the ffmpeg runs. `runExport`
 * takes them as a parameter so the filtergraph tests can build the real graph
 * for a spec with these stubbed. */
export interface ExportPipelineIO {
  exportSourceFiles: typeof exportSourceFiles;
  stat: typeof stat;
  writeFile: typeof writeFile;
  readFile: typeof readFile;
  unlink: typeof unlink;
  hasStream: typeof hasStream;
  audioChannels: typeof audioChannels;
  videoDecodeCost: typeof videoDecodeCost;
  videoDimensions: typeof videoDimensions;
  videoPicture: typeof videoPicture;
  mediaDuration: typeof mediaDuration;
  videoEncoder: (codec: ExportVideoCodec) => Promise<string>;
  runFfmpeg: typeof runFfmpeg;
  masterRawMix: typeof masterRawMix;
  packStems: typeof packStems;
}

const realIO: ExportPipelineIO = {
  masterRawMix,
  packStems,
  exportSourceFiles,
  stat,
  writeFile,
  readFile,
  unlink,
  hasStream,
  audioChannels,
  videoDecodeCost,
  videoDimensions,
  videoPicture,
  mediaDuration,
  videoEncoder,
  runFfmpeg,
};

/** Render `spec` into `job.outPath`. `mediaPathFor` maps a spec media file
 * name to its staged path on disk (the engine reads the project folder; the
 * worker reads its download dir); overlay/caption PNGs are read from
 * `job.tmpDir` by base name in both. */
export async function runExport(
  job: RenderHandle,
  given: ExportSpec,
  mediaPathFor: (file: string) => string,
  io: ExportPipelineIO = realIO
) {
  if (given.clips.length === 0) throw new Error("Nothing to export.");
  const codec = given.codec ?? "h264";
  // Stems are cut from the graph's own sound, so a spec that asks for them
  // renders.
  if (given.target === "export" && given.sourceSegments?.length && !given.stemPlan?.length && (codec === "h264" || codec === "hevc")) {
    for (const segment of given.sourceSegments) {
      if (!given.clips.some((clip) => segment.file === clip.file && segment.from >= clip.in && segment.to <= clip.out)) {
        // Adjacent splits of a source may be merged into one copy span.
        const clips = given.clips.filter((clip) => clip.file === segment.file).sort((a, b) => a.in - b.in);
        let covered = segment.from;
        for (const clip of clips) if (clip.in <= covered && clip.out > covered) covered = clip.out;
        if (covered < segment.to) throw new Error("Source export does not match the timeline media.");
      }
    }
    if (await io.exportSourceFiles(job, mediaPathFor, given.sourceSegments, codec, given.audioBitrate)) return;
  }

  // A long delivery renders in passes held to a memory budget, joined into
  // the one file at the end. A piece's cost follows its source's size and
  // frame rate. Every pass reads the same files, so each probe runs once.
  const probed = probesOnce(io);
  const pictures = new Map<string, SourcePicture>();
  const footage = [...given.clips, ...(given.overlayVideos ?? [])].filter((c) => c.file && !c.image && !c.removal);
  await Promise.all(
    [...new Set(footage.map((c) => c.file))].map(async (file) => {
      const picture = await probed.videoPicture(await resolveMedia(io.stat, mediaPathFor, file));
      pictures.set(file, picture ?? { pixels: 0, fps: given.fps });
    })
  );
  const windows = passWindows(given, (file) => pictures.get(file) ?? { pixels: 0, fps: given.fps });
  if (windows.length === 1) {
    await renderPass(job, given, mediaPathFor, probed, { kind: "delivery" });
    return;
  }
  await renderInPasses(job, given, windows, mediaPathFor, probed);
}

/**
 * `io` with each source probe answered once per file and kind. Durations stay
 * live: a bake reads back the length of a file it just wrote. A probe that
 * errors
 * replays its error to every caller, so each pass decides a stream's
 * presence the same way.
 */
function probesOnce(io: ExportPipelineIO): ExportPipelineIO {
  const once = <T>(probe: (file: string) => Promise<T>) => {
    const answers = new Map<string, Promise<T>>();
    return (file: string) => {
      if (!answers.has(file)) {
        answers.set(file, probe(file));
      }
      return answers.get(file)!;
    };
  };
  const streams = new Map<string, Promise<{ has: boolean; error?: Error }>>();
  const hasStream: ExportPipelineIO["hasStream"] = async (file, kind, onProbeError) => {
    const key = `${kind}:${file}`;
    if (!streams.has(key)) {
      let error: Error | undefined;
      streams.set(key, io.hasStream(file, kind, (e) => (error = e)).then((has) => ({ has, error })));
    }
    const { has, error } = await streams.get(key)!;
    if (error) {
      onProbeError?.(error);
    }
    return has;
  };
  return {
    ...io,
    hasStream,
    audioChannels: once(io.audioChannels),
    videoDecodeCost: once(io.videoDecodeCost),
    videoDimensions: once(io.videoDimensions),
    videoPicture: once(io.videoPicture),
  };
}

/**
 * Where one pass's render lands: the delivery itself, or a piece of a
 * delivery rendered in passes — its picture encoded for the delivery, its mix
 * and stems as sound to lay end to end — with the share of the job's
 * progress the pass covers.
 */
type PassOutput =
  | { kind: "delivery" }
  | { kind: "piece"; video: string; mix: string; stems: string[]; progress: [number, number] };

/** One encode pass over `given`, composited whole and cut to its range. */
async function renderPass(
  job: RenderHandle,
  given: ExportSpec,
  mediaPathFor: (file: string) => string,
  io: ExportPipelineIO,
  out: PassOutput
) {
  const codec = given.codec ?? "h264";
  let spec = await withSpecColors(narrowSpecToRange(given), mediaPathFor);
  const { width: W, height: H, fps } = spec;

  // The delivery's color space. An HDR file composites in HLG signal space
  // — every clip converts into it, every graphic maps into it, the effects
  // scale their constants to it — and a PQ file is one fixed pass over the
  // finished picture. H.264 is 8-bit and never carries it.
  const output: OutputSpace = spec.colorSpace ?? "sdr";
  const hdr = output !== "sdr";
  const compositeSpace = compositeSpaceFor(output);
  if (hdr && codec === "h264") throw new Error("H.264 is 8-bit. Export HDR as HEVC or ProRes.");

  // The chroma the composite is built at. A full-chroma delivery composites
  // at 4:4:4, so the titles, captions, stickers and masks the graph draws in
  // RGBA reach the file with every pixel's own color — a 4:2:0 graph averages
  // that away before the encoder ever sees it, whatever the file is written
  // as afterward. H.264 and HEVC subsample at the encoder regardless, so their
  // graph stays 4:2:0 and costs what it always did.
  //
  // Eight bits a plane for SDR: the sources decode to eight, and ProRes 4444
  // takes the exact widening to ten at the encoder. An HDR composite holds
  // ten, and the looks and effects scale their 8-bit constants to it.
  const full = deliveryCodec(spec.codec).chroma444 === true;
  const depth: 8 | 10 = hdr ? 10 : 8;
  const bits = hdr ? "10le" : "";
  const clipFmt = full ? `yuv444p${bits}` : `yuv420p${bits}`;
  const alphaFmt = full ? `yuva444p${bits}` : `yuva420p${bits}`;
  // `overlay` blends in its own pixel family, and its default is yuv420 —
  // left alone it would undo the graph's chroma at every composite.
  const ovl = full ? (hdr ? ":format=yuv444p10" : ":format=yuv444") : hdr ? ":format=yuv420p10" : "";
  /** The same family, for the effect chains the kit writes. */
  const chroma: ChainChroma = { pixFmt: clipFmt, overlay: ovl, depth };
  /** The matrix the composite's video carries, as ffmpeg spells it for the
   * scale filter and as a file's header names it. */
  const outMatrix = hdr ? "bt2020" : "bt709";
  const outMatrixName: CodeFormat["matrix"] = hdr ? "bt2020nc" : "bt709";
  // A segment that carries alpha — a painted or subject mask, a keyed pose,
  // a removal clip's keyed pair — rides RGBA through an SDR composite. An
  // HDR composite keeps it at ten bits in the video's own family, tagged
  // like the video so no negotiation converts it on the way: a mask reaches
  // the alpha plane through mergeplanes (alphamerge is an 8-bit filter) and
  // a mask multiply is a per-plane blend.
  const alphaHi = hdr ? "yuva444p10le" : "rgba";
  // Masks are 8-bit files. They widen to ten bits through 8-bit gray, which
  // is exact; a direct conversion lands white short of opaque (1020 of 1023).
  const maskFmt = hdr ? "gray,format=gray10le" : "gray";
  /** A format without its alpha plane. ffmpeg's ten-bit overlay onto a main
   * that carries alpha unpremultiplies with eight-bit constants and darkens
   * everything short of opaque, so an HDR composite never overlays onto one:
   * an opaque backdrop is opaque in format too. */
  const opaqueFmt = (fmt: string): string => (hdr ? fmt.replace(/^yuva/, "yuv") : fmt);
  /** The format an alpha-carrying segment holds through its edge effects. */
  const segAlpha = hdr ? alphaHi : alphaFmt;
  /** Into the alpha family from the composite's video. */
  const videoToAlpha = hdr ? `format=${alphaHi},setparams=range=tv:colorspace=${outMatrixName}` : "format=rgba";
  /** Into the alpha family from an RGB graphic (a mapped PNG, a keyed
   * pair's color piece), converted with the composite's matrix. */
  const rgbToAlpha = hdr ? `scale=out_color_matrix=${outMatrix}:out_range=tv,format=${alphaHi}` : "format=rgba";

  // A clip that plays backward is rendered off a turned copy of its span,
  // baked ahead of the graph in bounded chunks (turnMedia.ts): the clip
  // becomes a forward clip over that file, its curve's nodes carried along,
  // and everything below reads it like any other footage. The copy joins the
  // inputs by its own path, past the project-folder lookup.
  const turned = new Map<string, { video: boolean; audio: boolean; mono: boolean }>();
  const turn = async <
    T extends {
      file: string;
      in: number;
      out: number;
      speed?: number;
      speedCurve?: SpeedNode[];
      reverse?: boolean;
      soundBack?: number;
      soundAhead?: number;
      image?: boolean;
      hidden?: boolean;
    },
  >(
    c: T,
    tag: string,
    /** A soundtrack entry, whose picture the graph never reads. Detached from
     * a video file it would otherwise have its whole span re-encoded backward
     * frame by frame for nothing. */
    soundOnly = false
  ): Promise<T> => {
    if (!c.reverse || !c.file || c.image || c.hidden) return c;
    const src = twinFiles.has(c.file) ? c.file : await resolveMedia(io.stat, mediaPathFor, c.file);
    const rt = retimeOf(c);
    // The span plus the handles a crossing reaches into, so the copy holds
    // what the sound of a cross dissolve needs on either side.
    const reach = srcSpan(rt, -(c.soundBack ?? 0), rt.len + (c.soundAhead ?? 0));
    const lo = Math.max(0, reach.lo);
    const hi = Math.max(lo + 0.001, reach.hi);
    const video = !soundOnly && (await io.hasStream(src, "v"));
    const audio = await io.hasStream(src, "a");
    const mono = audio && (await io.audioChannels(src)) === 1;
    const decodeCost = video ? ((await io.videoDecodeCost(src)) ?? 0) : 0;
    const file = path.join(job.tmpDir, `turned_${tag}.${video ? "mov" : "wav"}`);
    const pivot = await bakeTurnedMedia(
      {
        ffmpeg: (args) => io.runFfmpeg(job, args),
        writeFile: (p, data) => io.writeFile(p, data),
        h264Encoder: () => io.videoEncoder("h264") as Promise<"libx264" | "h264_videotoolbox">,
        duration: io.mediaDuration,
      },
      src,
      { lo, hi, video, audio, decodeCost, fmt: clipFmt, master: full || hdr },
      file
    );
    turned.set(file, { video, audio, mono });
    return { ...mirrorRetimable(c, pivot), file };
  };
  // A video bound to a recording sounds from the recording. Each entry that
  // reads one gets a sound twin: the recording laid on the video's clock over
  // the stretch the entry reaches (soundAlign.ts), with the entry's trim and
  // map moved onto that file. Picture reads keep the entry; every sound read
  // below goes through `sounding`. A twin turns with its entry, and a
  // recording that holds none of the stretch leaves the entry silent.
  const twinFiles = new Set<string>();
  const twinOf = async <T extends Parameters<typeof turn>[0] & { soundFrom?: SpecSound; muted?: boolean }>(
    c: T,
    tag: string
  ): Promise<T | null | undefined> => {
    if (!c.soundFrom || !c.file || c.image || c.hidden || c.muted) return undefined;
    const rec = await resolveMedia(io.stat, mediaPathFor, c.soundFrom.file);
    const rt = retimeOf(c);
    const reach = srcSpan(rt, -(c.soundBack ?? 0), rt.len + (c.soundAhead ?? 0));
    const file = path.join(job.tmpDir, `bound_${tag}.wav`);
    const mono = (await io.audioChannels(rec)) === 1;
    const laid = await alignRecording((args) => io.runFfmpeg(job, args), rec, c.soundFrom, reach.lo, reach.hi, file, {
      mono,
    });
    if (!laid) return null;
    twinFiles.add(file);
    const { soundFrom: _bound, ...rest } = shiftSpan(c, -reach.lo);
    void _bound;
    return { ...rest, file } as T;
  };
  /** Each entry's sound twin, null for one whose recording is silent there. */
  const soundTwins = new Map<object, Sounding | null>();
  const turnedClips: ExportSpec["clips"] = [];
  for (const [j, c] of spec.clips.entries()) {
    const twin = await twinOf(c, `clip_${j}`);
    const tc = await turn(c, `clip_${j}`);
    turnedClips.push(tc);
    if (twin !== undefined) soundTwins.set(tc, twin && (await turn(twin, `clipsnd_${j}`, true)));
  }
  const turnedOverlays: NonNullable<ExportSpec["overlayVideos"]> = [];
  for (const [k, oc] of (spec.overlayVideos ?? []).entries()) {
    const twin = await twinOf(oc, `ovl_${k}`);
    const to = await turn(oc, `ovl_${k}`);
    turnedOverlays.push(to);
    if (twin !== undefined) soundTwins.set(to, twin && (await turn(twin, `ovlsnd_${k}`, true)));
  }
  const turnedAudio: ExportSpec["audio"] = [];
  for (const [k, a] of spec.audio.entries()) {
    const twin = await twinOf(a, `snd_${k}`);
    if (twin === null) continue;
    turnedAudio.push(await turn(twin ?? a, `snd_${k}`, true));
  }
  spec = { ...spec, clips: turnedClips, overlayVideos: turnedOverlays, audio: turnedAudio };
  /** What an entry's sound reads: its sound twin, or the entry itself. Null
   * when a bound recording holds nothing over it. */
  const sounding = <T extends Sounding>(c: T): T | Sounding | null => (soundTwins.has(c) ? soundTwins.get(c)! : c);
  /** The path an entry's file reads from: a twin is on disk already. */
  const sourcePath = (file: string) =>
    twinFiles.has(file) ? Promise.resolve(file) : resolveMedia(io.stat, mediaPathFor, file);

  // Tracks number 0..N bottom-up: track 0 folds sequentially into the base
  // picture, the rest overlay it in track order (highest last = frontmost).
  // Within a track, earlier clips composite first, so a dissolving pair
  // blends the incoming clip in over the outgoing one.
  const overlayVideos = [...(spec.overlayVideos ?? [])].sort(
    (a, b) => a.track - b.track || a.start - b.start
  );
  // Every bare patch of frame in the graph — the letterbox around a fitted
  // clip, a gap on track 0, the backdrop behind an edge animation — is the
  // project's own background color. ffmpeg takes it as 0xRRGGBB.
  const padColor = ffColor(hdr && spec.background ? hexToHlgHex(spec.background) : spec.background);
  /**
   * The chain that meets a clip's picture with its box: covering it (cropping
   * the overflow) or fitted inside it, zoomed, with the pan choosing what the
   * box keeps. The crop takes `min(picture, box)` per axis, so an axis with
   * room to spare passes through untouched and stays centered — the same
   * geometry `contentRect` draws on the canvas.
   */
  const boxFraming = (
    bw: number,
    bh: number,
    cover: boolean,
    zoom?: number,
    panX?: number,
    panY?: number,
    /** The source's matrix and range, so the scale that first touches the
     * code values converts them the way the file meant (see colorPlanFor). */
    flags = ""
  ): string => {
    const z = Math.max(1, Math.min(CLIP_MAX_ZOOM, zoom ?? 1));
    const even = (n: number) => 2 * Math.round(n / 2);
    const tw = even(bw * z);
    const th = even(bh * z);
    const scale = cover
      ? `scale=${tw}:${th}:force_original_aspect_ratio=increase${flags}`
      : `scale=${tw}:${th}:force_original_aspect_ratio=decrease:force_divisible_by=2${flags}`;
    // A fitted picture at rest overflows nothing, so it needs no crop at all.
    if (!cover && z <= 1.0001) return scale;
    const kx = num(0.5 + Math.max(-1, Math.min(1, panX ?? 0)) / 2);
    const ky = num(0.5 + Math.max(-1, Math.min(1, panY ?? 0)) / 2);
    return `${scale},crop=${fexpr(`min(iw,${bw})`)}:${fexpr(`min(ih,${bh})`)}:(iw-ow)*${kx}:(ih-oh)*${ky}`;
  };
  /** The height of the whole picture as `boxFraming` scales it into its box,
   * before any crop: the size the preview's detail pass sizes its radii to.
   * The zoomed box's height when the source size is unknown. */
  const framedPictureHeight = (file: string, bw: number, bh: number, cover: boolean, zoom?: number): number => {
    const z = Math.max(1, Math.min(CLIP_MAX_ZOOM, zoom ?? 1));
    const tw = 2 * Math.round((bw * z) / 2);
    const th = 2 * Math.round((bh * z) / 2);
    const dims = pictureDims.get(file);
    if (!dims) return th;
    const fitted = (tw * dims.height) / dims.width;
    return cover ? Math.max(th, fitted) : Math.min(th, fitted);
  };
  /** The mirror after the framing: the picture flips inside its box, the
   * way the canvas turns it about the box center. */
  const mirror = (c: { flipH?: boolean; flipV?: boolean }): string =>
    (c.flipH ? ",hflip" : "") + (c.flipV ? ",vflip" : "");
  // One ffmpeg input per distinct media file (from the project folder),
  // plus one per uploaded overlay PNG.
  // Still images are excluded here: a plain `-i file` decodes one frame, so
  // each image clip/overlay gets its own looped input below instead. Gap
  // spacers (empty file) reference no media at all — they render as black,
  // and so do hidden clips outside a range, whose files stay closed.
  const readers = [...spec.clips.filter((c) => !c.image && !c.hidden), ...spec.audio, ...overlayVideos.filter((o) => !o.image)];
  const mediaFiles = [...new Set(readers.map((c) => c.file).filter((f) => f && !turned.has(f) && !twinFiles.has(f)))];
  const audioPresence = new Map<string, boolean>();
  const videoPresence = new Map<string, boolean>();
  // Files whose audio is one channel. ffmpeg's own mono-to-stereo lays the
  // channel into each side 3 dB down; the browser's mixer, which the preview
  // and the in-tab fold play through, copies it at full level. Every read of
  // a mono file upmixes by hand so the export sits where the preview did.
  const monoFiles = new Set<string>();
  const toStereo = (file: string) =>
    `aresample=44100,${monoFiles.has(file) ? "pan=stereo|c0=c0|c1=c0," : ""}` +
    "aformat=sample_fmts=fltp:channel_layouts=stereo,";
  const inputs: string[] = [];
  const inputIndex = new Map<string, number>();
  // Counted explicitly: the concat input below carries extra flags, so the
  // args array is not a clean ["-i", path] pair per input.
  let nInputs = 0;
  // Resolve paths in order first so ffmpeg input indices stay deterministic,
  // then probe every file's streams concurrently.
  const paths = await Promise.all(mediaFiles.map((f) => resolveMedia(io.stat, mediaPathFor, f)));
  // Each file opens at the earliest source second the graph reads of it, so
  // a pass deep into a long recording never decodes the file from its start.
  // Re-stamped by the same amount, the input carries the timestamps an
  // unseeked one does, and every trim below reads it unchanged.
  const readFrom = new Map<string, number>();
  for (const c of readers) {
    const back = "soundBack" in c ? (c.soundBack ?? 0) : 0;
    const lo = srcSpan(retimeOf(c), -back, 0).lo - SOURCE_PREROLL - READ_MARGIN_S;
    readFrom.set(c.file, Math.min(readFrom.get(c.file) ?? Infinity, lo));
  }
  mediaFiles.forEach((f, i) => {
    inputIndex.set(f, nInputs++);
    const at = Math.floor(readFrom.get(f) ?? 0);
    inputs.push(...(at >= READ_SEEK_MIN_S ? ["-ss", num(at), "-itsoffset", num(at)] : []), "-i", paths[i]);
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
      if (hasAudio && (await io.audioChannels(paths[i])) === 1) monoFiles.add(f);
      let videoProbeFailed = false;
      const hasVideo = await io.hasStream(paths[i], "v", () => (videoProbeFailed = true));
      videoPresence.set(f, hasVideo || videoProbeFailed);
    })
  );
  // The source size of every picture a detail pass runs on: its radii follow
  // the whole picture's height as framed, which the size and the box decide.
  const pictureDims = new Map<string, { width: number; height: number } | null>();
  const detailed = [...spec.clips, ...overlayVideos].filter((c) => c.file && detailActive(c.grade));
  await Promise.all(
    [...new Map(detailed.map((c) => [c.file, c])).values()].map(async (c) => {
      const at = turned.has(c.file)
        ? c.file
        : c.image && "staged" in c && c.staged
          ? path.join(job.tmpDir, path.basename(c.file))
          : await resolveMedia(io.stat, mediaPathFor, c.file);
      pictureDims.set(c.file, await io.videoDimensions(at));
    })
  );
  // The turned copies: already probed at the bake.
  for (const [file, streams] of turned) {
    inputIndex.set(file, nInputs++);
    inputs.push("-i", file);
    audioPresence.set(file, streams.audio);
    videoPresence.set(file, streams.video);
    if (streams.mono) monoFiles.add(file);
  }
  // The sound twins still read forward: stereo sound, written just now.
  for (const file of new Set([...soundTwins.values(), ...spec.audio].map((e) => e?.file ?? ""))) {
    if (!twinFiles.has(file)) continue;
    inputIndex.set(file, nInputs++);
    inputs.push("-i", file);
    audioPresence.set(file, true);
    videoPresence.set(file, false);
  }
  // Animated overlays: each is its own concat-demuxer slideshow (region-sized
  // frames with transparent filler around the element's window), the exact
  // mechanism the caption lanes use. Static overlays stay single PNG inputs.
  const animOverlayInput = new Map<number, number>();
  for (let k = 0; k < spec.overlays.length; k++) {
    const o = spec.overlays[k];
    if (o.frames?.length && o.blank) {
      const blank = path.join(job.tmpDir, path.basename(o.blank));
      // Blank up to the element, each picture to its end, blank after it.
      const holds: { file: string; to: number }[] = [];
      if (o.start > 1e-3) holds.push({ file: blank, to: o.start });
      let cursor = o.start;
      for (const f of o.frames) {
        cursor += f.duration;
        // A sliver no frame falls in stretches the hold before it.
        if (f.duration < 1e-4 && holds.length > 0) {
          holds[holds.length - 1].to = cursor;
          continue;
        }
        holds.push({ file: path.join(job.tmpDir, path.basename(f.file)), to: cursor });
      }
      if (spec.duration - cursor > 1e-3) {
        holds.push({ file: blank, to: spec.duration });
      }
      const list = path.join(job.tmpDir, `overlay_anim_${k}.ffconcat`);
      await io.writeFile(list, concatList(holds, fps));
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
    if (!c.image || !c.file || c.hidden) {
      continue;
    }
    const dur = spanLen(c);
    imageClipInput.set(j, nInputs++);
    inputs.push(
      "-loop", "1", "-t", num(dur), "-framerate", String(fps), "-i",
      c.staged
        ? path.join(job.tmpDir, path.basename(c.file))
        : await resolveMedia(io.stat, mediaPathFor, c.file)
    );
  }
  const imageOverlayInput = new Map<(typeof overlayVideos)[number], number>();
  for (const oc of overlayVideos) {
    if (!oc.image) continue;
    const olen = spanLen(oc);
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
      const holds: { file: string; to: number }[] = [];
      let cursor = 0;
      for (const f of mk.frames) {
        cursor += f.duration;
        // A sliver no frame falls in stretches the hold before it.
        if (f.duration < 1e-4 && holds.length > 0) {
          holds[holds.length - 1].to = cursor;
          continue;
        }
        holds.push({ file: path.join(job.tmpDir, path.basename(f.file)), to: cursor });
      }
      const list = path.join(job.tmpDir, `${tag}.ffconcat`);
      await io.writeFile(list, concatList(holds, fps));
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
    const dur = c.file ? spanLen(c) : Math.max(0, c.out - c.in);
    const idx = await maskInput(c.mask, dur, `mask_clip_${j}`);
    if (idx !== undefined) clipMaskInput.set(j, idx);
  }
  const overlayMaskInput = new Map<(typeof overlayVideos)[number], number>();
  for (let k = 0; k < overlayVideos.length; k++) {
    const oc = overlayVideos[k];
    if (!oc.mask) continue;
    const olen = spanLen(oc);
    const idx = await maskInput(oc.mask, olen, `mask_ovl_${k}`);
    if (idx !== undefined) overlayMaskInput.set(oc, idx);
  }
  // Shadows arrive the same way coverage does — one looped still, or a
  // slideshow when the clip moves — so they take the same input builder.
  const clipShadowInput = new Map<number, number>();
  for (let j = 0; j < spec.clips.length; j++) {
    const c = spec.clips[j];
    if (!c.shadow) continue;
    const dur = c.file ? spanLen(c) : Math.max(0, c.out - c.in);
    const idx = await maskInput(c.shadow, dur, `shadow_clip_${j}`);
    if (idx !== undefined) clipShadowInput.set(j, idx);
  }
  const overlayShadowInput = new Map<(typeof overlayVideos)[number], number>();
  for (let k = 0; k < overlayVideos.length; k++) {
    const oc = overlayVideos[k];
    if (!oc.shadow) continue;
    // An overlay's shadow lands on the timeline beside the clip, so it plays
    // for the clip's whole window rather than the segment's local clock.
    const olen = spanLen(oc);
    const idx = await maskInput(oc.shadow, olen, `shadow_ovl_${k}`);
    if (idx !== undefined) overlayShadowInput.set(oc, idx);
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
    const dur = c.file ? spanLen(c) : Math.max(0, c.out - c.in);
    clipBorderInput.set(j, borderStill(c.border, dur));
  }
  const overlayBorderInput = new Map<(typeof overlayVideos)[number], number>();
  for (const oc of overlayVideos) {
    if (!oc.border) continue;
    const olen = spanLen(oc);
    overlayBorderInput.set(oc, borderStill(oc.border, olen));
  }

  // Removal pieces: each removal clip's keyed layer arrives as a color/alpha
  // video pair uploaded with the stills; the pair replaces the source decode.
  const removalInputs = (rm: { rgb: string; alpha: string }) => {
    const rgb = nInputs++;
    inputs.push("-i", path.join(job.tmpDir, path.basename(rm.rgb)));
    const a = nInputs++;
    inputs.push("-i", path.join(job.tmpDir, path.basename(rm.alpha)));
    return { rgb, a };
  };
  const clipRemovalInput = new Map<number, { rgb: number; a: number }>();
  for (let j = 0; j < spec.clips.length; j++) {
    const c = spec.clips[j];
    if (c.removal && !c.hidden) {
      clipRemovalInput.set(j, removalInputs(c.removal));
    }
  }
  const overlayRemovalInput = new Map<(typeof overlayVideos)[number], { rgb: number; a: number }>();
  for (const oc of overlayVideos) {
    if (oc.removal) overlayRemovalInput.set(oc, removalInputs(oc.removal));
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
    const holds: { file: string; to: number }[] = [];
    let cursor = 0;
    for (const c of entries) {
      const from = Math.max(c.start, cursor);
      if (c.end - from < 1e-3) continue;
      if (from - cursor > 1e-3) holds.push({ file: blank, to: from });
      holds.push({ file: path.join(job.tmpDir, path.basename(c.file)), to: c.end });
      cursor = c.end;
    }
    if (spec.duration - cursor > 1e-3) {
      holds.push({ file: blank, to: spec.duration });
    }
    const list = path.join(job.tmpDir, `captions_${lane}.ffconcat`);
    await io.writeFile(list, concatList(holds, fps));
    captionInputs.push(nInputs++);
    inputs.push("-f", "concat", "-safe", "0", "-i", list);
  }

  const filters: string[] = [];

  // A clip's own effects run on its segment's clock over its framed
  // picture, after its look: chain fragment `core` in, the treated fragment
  // out. The clock starts `from` seconds in (a split's right half carries
  // on), and `lead` more when the clip's first frame falls after its start,
  // so the effects begin at -(from + lead) on the segment's clock. The fades,
  // pad and mask that follow carry them, as in the preview.
  const wearEffects = (core: string, c: { effects?: ClipEffect[]; effectsFrom?: number }, len: number, w: number, h: number, pixFmt: string, tag: string, lead: number) => {
    const from = (c.effectsFrom ?? 0) + lead;
    for (const [n, e] of (c.effects ?? []).entries()) {
      const lines = effectFilterLines(`${tag}fi${n}`, `${tag}fo${n}`, e.effect, e.amount, -from, len, w, h, `${tag}x${n}`, undefined, undefined, { ...chroma, pixFmt }, e);
      if (!lines) continue;
      filters.push(`${core}[${tag}fi${n}]`, ...lines);
      core = `[${tag}fo${n}]null`;
    }
    return core;
  };

  // One color mapping per clip: the source conversion, the library LUT and
  // the grade baked into one 3D LUT (effects-kit colorPipeline.ts), written
  // to the job dir as .cube once per distinct recipe and applied with lut3d.
  // The clip's picture goes through it in 16-bit RGB with the file's own
  // matrix and range spelled out, so what the file meant is what the LUT
  // sees, and comes back to BT.709 video for the rest of the chain.
  type ColorOwner = { color?: SpecClipColor; grade?: ColorGrade; image?: boolean };
  const REC709: SpecClipColor = { profile: "rec709", matrix: "bt709", fullRange: false };
  const SRGB: SpecClipColor = { profile: "srgb", matrix: "bt709", fullRange: true };
  const colorOf = (o: ColorOwner): SpecClipColor => o.color ?? (o.image ? SRGB : REC709);
  const recipeOf = (o: ColorOwner): ClipColorRecipe => {
    const profile = colorOf(o).profile;
    const wide = profile !== "rec709" && profile !== "srgb";
    return { profile, grade: o.grade, output: compositeSpace, size: wide ? spec.lutSizeWide ?? 65 : spec.lutSize ?? 33 };
  };
  const recipeId = (o: ColorOwner): string => {
    const key = recipeKey(recipeOf(o));
    return key ? `${key}|${colorOf(o).lutFile ?? ""}` : "";
  };
  const userLuts = new Map<string, ParsedLut>();
  const userLutFor = async (file: string): Promise<ParsedLut> => {
    const held = userLuts.get(file);
    if (held) return held;
    let parsed: ParsedLut;
    try {
      const text = Buffer.from(await io.readFile(path.join(job.tmpDir, path.basename(file)))).toString("utf8");
      parsed = parseLutFile(file, text);
    } catch (e) {
      throw new Error(`The LUT ${file} could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
    userLuts.set(file, parsed);
    return parsed;
  };
  /** Recipe identity → the lut3d filter over its .cube, or "" for identity. */
  const lutFilters = new Map<string, string>();
  for (const owner of [...spec.clips, ...(spec.overlayVideos ?? [])]) {
    const id = recipeId(owner);
    if (!id || lutFilters.has(id)) continue;
    const lutFile = colorOf(owner).lutFile;
    const lut = buildClipLut(recipeOf(owner), lutFile ? await userLutFor(lutFile) : undefined);
    if (!lut) {
      lutFilters.set(id, "");
      continue;
    }
    const file = path.join(job.tmpDir, `clip_${lutFilters.size}.cube`);
    await io.writeFile(file, lutToCube(lut));
    lutFilters.set(id, `lut3d=file=${fexpr(file)}:interp=tetrahedral`);
  }
  // Every graphic the graph lays over the picture — titles, captions,
  // stickers, border rings, shadows, the keyed pieces a removal clip ships
  // — is drawn in sRGB. An HDR composite takes each one through the same
  // BT.2408 mapping the SDR clips take, so a white title sits at reference
  // white beside them.
  let graphicsLut = "";
  if (hdr) {
    const file = path.join(job.tmpDir, "graphics.cube");
    await io.writeFile(file, lutToCube(buildTransferLut(spec.lutSize ?? 33, graphicsToHlg), "sRGB to HLG"));
    graphicsLut = `lut3d=file=${fexpr(file)}:interp=tetrahedral`;
  }
  let gfxN = 0;
  /** A graphic input's stream mapped into the composite: the input label as
   * is for SDR, a mapped copy in HDR. */
  const gfx = (src: string): string => {
    if (!graphicsLut) return src;
    const out = `gfx${gfxN++}`;
    filters.push(`[${src}]format=gbrap16le,${graphicsLut}[${out}]`);
    return out;
  };
  /** A gray mask as the operand the HDR alpha filters take: a four-plane
   * copy of it in the alpha family, stamped with the video's tags. */
  const maskCarrier = (mask: string, out: string): string => {
    filters.push(
      `[${mask}]mergeplanes=0x00000000:format=${alphaHi},setparams=range=tv:colorspace=${outMatrixName}[${out}]`
    );
    return out;
  };
  /** `[cur]` with its alpha multiplied by the gray mask `[mask]`, into
   * `[out]`; `tail` follows the merge and `tag` names the intermediates. */
  const alphaMultiply = (cur: string, mask: string, out: string, tag: string, tail = "") => {
    if (hdr) {
      const m = maskCarrier(mask, `${tag}k`);
      filters.push(`[${cur}]${videoToAlpha}[${tag}c]`);
      filters.push(
        `[${tag}c][${m}]blend=c0_mode=normal:c1_mode=normal:c2_mode=normal:c3_mode=multiply${tail}[${out}]`
      );
      return;
    }
    filters.push(`[${cur}]format=rgba,split[${tag}0][${tag}1]`);
    filters.push(`[${tag}1]alphaextract[${tag}a]`);
    filters.push(`[${tag}a][${mask}]blend=all_mode=multiply[${tag}m]`);
    filters.push(`[${tag}0][${tag}m]alphamerge${tail}[${out}]`);
  };
  /** `[cur]` with its alpha set to the gray `[mask]` (a keyed pair's luma
   * piece), into `[out]`; `tail` follows the merge. */
  const alphaSet = (cur: string, mask: string, out: string, tag: string, tail = "") => {
    if (hdr) {
      const m = maskCarrier(mask, `${tag}k`);
      filters.push(`[${cur}][${m}]mergeplanes=0x00010210:format=${alphaHi}${tail}[${out}]`);
      return;
    }
    filters.push(`[${cur}][${mask}]alphamerge${tail}[${out}]`);
  };
  /**
   * `[top]` placed at (`x`, `y`) on a clear W×H frame `dur` seconds long,
   * into `[out]`; `base` names the clear frame. An HDR composite overlays
   * only onto opaque frames (see `opaqueFmt`), and the posed picture may
   * change size every frame, which only `overlay` takes: the color lands with
   * its alpha dropped, and the alpha is read back off the picture laid on a
   * zero frame and on a full one, whose difference is `1 − alpha`.
   */
  const placeOnClear = (top: string, x: string, y: string, dur: number, base: string, out: string) => {
    const frame = `s=${W}x${H}:r=${fps}:d=${num(dur)}`;
    if (!hdr) {
      filters.push(`color=c=black@0.0:${frame},format=${alphaFmt}[${base}]`);
      filters.push(`[${base}][${top}]overlay=x=${x}:y=${y}:eof_action=pass${ovl}[${out}]`);
      return;
    }
    const plain = "yuv444p10le";
    const tags = `setparams=range=tv:colorspace=${outMatrixName}`;
    const place = `overlay=x=${x}:y=${y}:eof_action=pass:format=yuv444p10`;
    /** A constant frame with every plane at `level`'s gray value. */
    const flat = (level: "black" | "white") => `color=c=${level}:${frame},format=gray10le,mergeplanes=0x00000000:format=${plain},${tags}`;
    filters.push(`[${top}]format=${alphaHi},split=3[${base}c][${base}z][${base}f]`);
    filters.push(`color=c=black:${frame},format=${plain},${tags}[${base}cb]`);
    filters.push(`[${base}c]format=${plain},${tags}[${base}co]`);
    filters.push(`[${base}cb][${base}co]${place}[${base}cp]`);
    filters.push(`${flat("black")}[${base}zb]`);
    filters.push(`${flat("white")},split[${base}fb][${base}ff]`);
    filters.push(`[${base}zb][${base}z]${place}[${base}zp]`);
    filters.push(`[${base}fb][${base}f]${place}[${base}fp]`);
    filters.push(`[${base}fp][${base}zp]blend=all_mode=subtract[${base}inv]`);
    filters.push(`[${base}ff][${base}inv]blend=all_mode=subtract[${base}ap]`);
    filters.push(`[${base}cp][${base}ap]mergeplanes=0x00010210:format=${alphaHi}[${out}]`);
  };
  const ffMatrix = (m: CodeFormat["matrix"]): string => (m === "bt601" ? "bt601" : m === "bt2020nc" ? "bt2020" : "bt709");
  /** The sharpen and clarity pass on 16-bit 4:4:4 video, luma only: each
   * detail is the luma against its own base (a Gaussian blur, or the guided
   * filter over its window — sized to the picture, run on a reduced copy
   * when the window outgrows the filter's reach), gained and merged back.
   * Both bases read the input luma, so the two controls never feed each
   * other (detail.ts). */
  const detailLines = (inLabel: string, outLabel: string, g: ColorGrade, hPx: number, tag: string): string[] => {
    const ks = detailGain("sharpen", g.sharpen || 0);
    const kc = detailGain("clarity", g.clarity || 0);
    const t = `dt${tag}`;
    const lines: string[] = [];
    const radius = kc > 0 ? detailRadius("clarity", hPx) : 0;
    // guided takes a window up to 20; a wider one runs on a copy reduced to
    // fit and is read back at the picture's own size, off one more copy.
    const sub = Math.ceil(radius / 20);
    const copies = 1 + (ks > 0 ? 2 : 0) + (kc > 0 ? (sub > 1 ? 3 : 2) : 0);
    lines.push(
      `[${inLabel}]split=${copies}[${t}o]${ks > 0 ? `[${t}ss][${t}sr]` : ""}${kc > 0 ? `[${t}cs][${t}cr]${sub > 1 ? `[${t}cx]` : ""}` : ""}`
    );
    const gain = (k: number) => `lutyuv=y=${fexpr(`clip((val-32768)*${num(k)}+32768,0,65535)`)}`;
    const extract = "blend=c0_mode=grainextract";
    const merge = "blend=c0_mode=grainmerge";
    if (ks > 0) {
      lines.push(`[${t}ss]gblur=sigma=${num(detailRadius("sharpen", hPx))}:planes=1[${t}sb]`);
      lines.push(`[${t}sr][${t}sb]${extract},${gain(ks)}[${t}sd]`);
    }
    if (kc > 0) {
      if (sub <= 1) {
        lines.push(`[${t}cs]guided=radius=${radius}:eps=${num(CLARITY_EPS)}:planes=1[${t}cb]`);
        lines.push(`[${t}cr][${t}cb]${extract},${gain(kc)}[${t}cd]`);
      } else {
        const r = Math.max(1, Math.round(radius / sub));
        lines.push(
          `[${t}cs]scale=${fexpr(`ceil(iw/${sub})`)}:${fexpr(`ceil(ih/${sub})`)}:flags=bilinear,` +
            `guided=radius=${r}:eps=${num(CLARITY_EPS)}:planes=1[${t}cq]`
        );
        lines.push(`[${t}cq][${t}cx]scale=rw:rh:flags=bilinear[${t}cb]`);
        lines.push(`[${t}cr][${t}cb]${extract},${gain(kc)}[${t}cd]`);
      }
    }
    let cur = `${t}o`;
    if (ks > 0) {
      const next = kc > 0 ? `${t}m1` : outLabel;
      lines.push(`[${cur}][${t}sd]${merge}[${next}]`);
      cur = next;
    }
    if (kc > 0) lines.push(`[${cur}][${t}cd]${merge}[${outLabel}]`);
    return lines;
  };
  /**
   * How a picture's color runs: the flags its framing scale takes, and the
   * chain that follows the framing — into 16-bit RGB with the file's matrix
   * and range, through the LUT, the detail pass, and back to BT.709 video.
   * Null when the picture is Rec.709 video already and carries no color.
   */
  interface ColorPlan {
    flags: string;
    /** Extend `core` (a chain ending in the framed picture) with the color
     * chain, pushing any multi-input lines; returns the new chain. */
    run: (core: string, tag: string) => string;
  }
  const colorPlanFor = (
    o: ColorOwner,
    opts: { alpha: boolean; hPx: number; interpolated: boolean }
  ): ColorPlan | null => {
    const color = colorOf(o);
    const lut = lutFilters.get(recipeId(o)) ?? "";
    const det = o.grade && detailActive(o.grade) ? o.grade : null;
    // A still decodes to RGB, where a matrix means nothing.
    const yuv = !o.image;
    const inFlags = yuv ? `:in_color_matrix=${ffMatrix(color.matrix)}:in_range=${color.fullRange ? "pc" : "tv"}` : "";
    if (!lut && !det) {
      // Nothing to bake: a file whose code values are not the composite's
      // video still converts to it, in video, so the delivery's tags tell
      // the truth.
      if (yuv && (color.matrix !== outMatrixName || color.fullRange)) {
        return { flags: inFlags, run: (core) => `${core},scale${inFlags}:out_color_matrix=${outMatrix}:out_range=tv` };
      }
      return null;
    }
    const rgb16 = opts.alpha ? "gbrap16le" : "gbrp16le";
    const yuv16 = opts.alpha ? "yuva444p16le" : "yuv444p16le";
    return {
      flags: inFlags,
      run: (core, tag) => {
        // Motion interpolation between the framing and here works in video,
        // so the conversion is spelled out again where it actually happens.
        let chain = core + (yuv && opts.interpolated ? `,scale${inFlags},format=${rgb16}` : `,format=${rgb16}`);
        if (lut) chain += `,${lut}`;
        if (det) {
          chain += `,scale=out_color_matrix=${outMatrix}:out_range=pc,format=${yuv16}`;
          filters.push(`${chain}[dti${tag}]`);
          filters.push(...detailLines(`dti${tag}`, `dto${tag}`, det, opts.hPx, tag));
          return `[dto${tag}]null,scale=in_color_matrix=${outMatrix}:in_range=pc:out_color_matrix=${outMatrix}:out_range=tv`;
        }
        return `${chain},scale=out_color_matrix=${outMatrix}:out_range=tv`;
      },
    };
  };
  /** Whether a clip's framing is followed by motion interpolation. */
  const interpolates = (c: { smoothSlow?: boolean; image?: boolean }, rt: Retime): boolean =>
    !c.image && !!c.smoothSlow && slowRuns(rt, 1 / fps).length > 0;

  // Per-clip timeline length (source span compressed/expanded by speed). A
  // gap spacer (no file) keeps its exact length: flooring it at 0.1s would
  // land everything after the gap later than the timeline shows, drifting
  // burned-in captions off the picture.
  const clipDur = (c: ExportSpec["clips"][number]) =>
    c.file ? spanLen(c) : Math.max(0, c.out - c.in);

  // A clip whose rate changes through its footage gets its sound baked ahead
  // of the graph (retimeAudio.ts): the span plus the handles a crossing can
  // reach into, laid in timeline seconds. The WAV joins the inputs and every
  // audio read of that clip comes from it, needing no tempo.
  type Sounding = {
    file: string;
    in: number;
    out: number;
    speed?: number;
    speedCurve?: SpeedNode[];
    reverse?: boolean;
    soundBack?: number;
    soundAhead?: number;
    muted?: boolean;
    hidden?: boolean;
    image?: boolean;
  };
  const baked = new Map<Sounding, BakedAudio & { idx: number }>();
  const bakeTargets: { c: Sounding | null; tag: string }[] = [
    ...spec.clips.map((c, j) => ({ c: sounding(c), tag: `clip_${j}` })),
    ...overlayVideos.map((oc, k) => ({ c: sounding(oc), tag: `ovl_${k}` })),
    ...spec.audio.map((a, k) => ({ c: a, tag: `snd_${k}` })),
  ];
  for (const { c, tag } of bakeTargets) {
    if (!c) continue;
    const rt = retimeOf(c);
    if (rt.uniform || !c.file || c.image || c.muted || c.hidden || !audioPresence.get(c.file)) continue;
    const file = path.join(job.tmpDir, `retime_${tag}.wav`);
    const src = await sourcePath(c.file);
    const bake = await bakeRetimedAudio(
      {
        ffmpeg: (args) => io.runFfmpeg(job, args),
        readFile: (p) => io.readFile(p),
        writeFile: (p, data) => io.writeFile(p, data),
        unlink: (p) => io.unlink(p),
      },
      src,
      rt,
      c.soundBack ?? 0,
      c.soundAhead ?? 0,
      file,
      { mono: monoFiles.has(c.file) }
    );
    const idx = nInputs++;
    inputs.push("-i", file);
    baked.set(c, { ...bake, idx });
  }
  /**
   * The head of an audio chain reading a clip's sound over the timeline-local
   * window `[fromT, toT]` (seconds from the clip's head; negative reaches
   * into the back handle): the input, its trim, and the tempo that lays it
   * at the clip's rate. A baked clip is read from its WAV in timeline seconds
   * and needs none.
   */
  const audioRead = (c: Sounding, fromT: number, toT: number): string => {
    const b = baked.get(c);
    if (b) {
      return `[${b.idx}:a]atrim=${num(Math.max(0, b.back + fromT))}:${num(Math.max(0, b.back + toT))},asetpts=PTS-STARTPTS,`;
    }
    const rt = retimeOf(c);
    const tempo = rt.rate !== 1 ? `${atempoChain(rt.rate)},` : "";
    return `[${inputIndex.get(c.file)!}:a]atrim=${num(rt.srcAt(fromT))}:${num(rt.srcAt(toT))},asetpts=PTS-STARTPTS,${tempo}`;
  };
  /** Timeline seconds of source a clip has before its head, at its own pace. */
  const headRoom = (c: Sounding) => Math.max(0, -retimeOf(c).tAt(0));
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

  // The output frames each track-0 clip owns. The frame at time t shows the
  // clip that has started by t, as the preview does, so a clip runs from
  // the first frame at or after its start to the first one at or after its
  // end: a cut at frame 106.3 lands on frame 107. A clip that holds no frame
  // of its own still shows one, and the next clip takes it back.
  const segFrames: { first: number; count: number }[] = [];
  {
    let next = 0;
    spec.clips.forEach((c, j) => {
      const count = Math.max(1, gridFrame(clipStarts[j] + clipDur(c), fps) - next);
      segFrames.push({ first: next, count });
      next += count;
    });
  }
  /** Seconds from clip j's start to its first frame. */
  const segLead = (j: number) => segFrames[j].first / fps - clipStarts[j];

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
      `[${behindMaskInput}:v]fps=${fps},scale=${W}:${H},setsar=1,format=${maskFmt},` +
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
  // The pose track runs key to key along each key's ease with the ends held
  // flat, exactly the kit evaluator: v0 + Σ Δi·ease(clip((V−ti)/(ti+1−ti),0,1))
  // builds that shape as one expression, safe inside overlay/scale/rotate.
  /** easeAt from the kit as an ffmpeg expression over progress `u`. */
  const easeExpr = (ease: EaseId | undefined, u: string): string => {
    switch (ease) {
      case "sine.in":
        return `(1-cos(${u}*PI/2))`;
      case "sine.out":
        return `sin(${u}*PI/2)`;
      case "sine.inOut":
        return `((1-cos(PI*${u}))/2)`;
      case "power2.in":
        return `pow(${u},2)`;
      case "power2.out":
        return `(1-pow(1-${u},2))`;
      case "power2.inOut":
        return `if(lt(${u},0.5),2*pow(${u},2),1-pow(2-2*${u},2)/2)`;
      case "power3.in":
        return `pow(${u},3)`;
      case "power3.out":
        return `(1-pow(1-${u},3))`;
      case "power3.inOut":
        return `if(lt(${u},0.5),4*pow(${u},3),1-pow(2-2*${u},3)/2)`;
      default:
        return u;
    }
  };
  const piecewiseExpr = (keys: { t: number; v: number; ease?: EaseId }[], varExpr: string): string => {
    const ks = [...keys].sort((a, b) => a.t - b.t);
    let e = `${num(ks[0].v)}`;
    for (let i = 0; i < ks.length - 1; i++) {
      const dt = Math.max(1e-6, ks[i + 1].t - ks[i].t);
      const dv = ks[i + 1].v - ks[i].v;
      if (Math.abs(dv) < 1e-9) continue;
      e += `+${num(dv)}*${easeExpr(ks[i].ease, `clip((${varExpr}-${num(ks[i].t)})/${num(dt)},0,1)`)}`;
    }
    return `(${e})`;
  };
  /** The pose track's rotation values unwrapped into cumulative degrees, so
   * the expression lerps the short way around like the kit evaluator. */
  const unwrappedRotation = (kf: OverlayKey[]): { t: number; v: number; ease?: EaseId }[] => {
    const ks = sortedKeys(kf);
    const out: { t: number; v: number; ease?: EaseId }[] = [{ t: ks[0].t, v: ks[0].rotation, ease: ks[0].ease }];
    for (let i = 1; i < ks.length; i++) {
      out.push({
        t: ks[i].t,
        v: out[i - 1].v + shortestTurn(ks[i - 1].rotation, ks[i].rotation),
        ease: ks[i].ease,
      });
    }
    return out;
  };
  const varies = (kf: OverlayKey[], field: "x" | "y" | "scale" | "rotation") =>
    kf.some((k) => Math.abs(k[field] - kf[0][field]) > 1e-6);
  /** The rotate/scale filters a keyed segment runs before positioning, on
   * its own local clock. `boxW`/`boxH` give the constant rotate canvas. */
  /** The key clock on a stream whose time 0 sits `startAt` seconds into the
   * item: `(t-1.500)` for an element starting at 1.5 s on the timeline,
   * `(t+0.023)` for a segment whose first frame lands 0.023 s in. */
  const keyClock = (startAt: number): string => {
    if (startAt > 1e-9) {
      return `(t-${num(startAt)})`;
    }
    return startAt < -1e-9 ? `(t+${num(-startAt)})` : "t";
  };
  const poseTransformFilters = (
    kf: OverlayKey[],
    boxW: number,
    boxH: number,
    lead: number
  ): string => {
    const ks = sortedKeys(kf);
    const v = keyClock(-lead);
    let chain = "";
    if (varies(ks, "rotation") || Math.abs(ks[0].rotation) > 1e-6) {
      const diag = 2 * Math.ceil(Math.hypot(boxW, boxH) / 2);
      const rot = piecewiseExpr(unwrappedRotation(ks), v);
      chain += `,rotate=a='${rot}*PI/180':ow=${diag}:oh=${diag}:c=black@0.0`;
    }
    if (varies(ks, "scale") || Math.abs(ks[0].scale - 1) > 1e-6) {
      const sc = piecewiseExpr(ks.map((k) => ({ t: k.t, v: k.scale, ease: k.ease })), v);
      chain += `,scale=w='trunc(iw*${sc}/2)*2':h=-2:eval=frame`;
    }
    return chain;
  };
  /** The overlay x/y expressions placing a keyed segment's center at its
   * pose, with the key clock offset to `startAt` on the consuming stream's
   * timeline (minus the lead for a segment-clock base). */
  const posePositionExprs = (kf: OverlayKey[], startAt: number): { x: string; y: string } => {
    const ks = sortedKeys(kf);
    const v = keyClock(startAt);
    return {
      x: `'${piecewiseExpr(ks.map((k) => ({ t: k.t, v: k.x, ease: k.ease })), v)}*${W}-w/2'`,
      y: `'${piecewiseExpr(ks.map((k) => ({ t: k.t, v: k.y, ease: k.ease })), v)}*${H}-h/2'`,
    };
  };
  // ---- Keyed blur and motion blur on a posed segment ----------------------
  // The kit evaluator samples the clip's key blur and motion streak on every
  // output frame, eases and all, so the graph softens what the preview does.
  // The segment pads onto a constant canvas with room for the smear and the
  // blur, premultiplies, averages copies shifted along the streak (the
  // preview's additive taps), and blurs with a Gaussian whose sigma sendcmd
  // sets frame by frame. Each stage runs only over the frames that soften,
  // so an 8-frame settle costs nothing for the rest of the clip.
  const softenPose = (
    cur: string,
    c: Parameters<typeof clipFrameAt>[0] & { kf?: OverlayKey[] },
    dur: number,
    boxW: number,
    boxH: number,
    toAlpha: string,
    tag: string,
    lead: number
  ): string => {
    if (!c.kf?.length || (!c.motionBlur && !c.kf.some((k) => k.blur))) return cur;
    const even = (n: number) => 2 * Math.ceil(n / 2);
    const q = (v: number) => Math.round(v * 20) / 20;

    // Per-frame blur sigma and streak, output px, on the segment's clock;
    // the kit samples the clip `lead` seconds further in, where it stands.
    const n = Math.max(1, Math.round(dur * fps));
    const blurs: { t: number; v: number }[] = [];
    const sx: { t: number; v: number }[] = [];
    const sy: { t: number; v: number }[] = [];
    let first = -1;
    let last = -1;
    let taps = 0;
    let maxBlur = 0;
    let reachX = 0;
    let reachY = 0;
    for (let i = 0; i < n; i++) {
      const t = i / fps;
      const look = elementLook(clipFrameAt(c, t + lead, W / H), outScale);
      const b = q(look?.blur ?? 0);
      const x = look && look.taps >= 2 ? q(look.streakX) : 0;
      const y = look && look.taps >= 2 ? q(look.streakY) : 0;
      blurs.push({ t, v: b });
      sx.push({ t, v: x });
      sy.push({ t, v: y });
      if (!b && !x && !y) {
        continue;
      }
      if (first < 0) {
        first = i;
      }
      last = i;
      taps = Math.max(taps, x || y ? (look?.taps ?? 0) : 0);
      maxBlur = Math.max(maxBlur, b);
      reachX = Math.max(reachX, Math.abs(x) / 2);
      reachY = Math.max(reachY, Math.abs(y) / 2);
    }
    if (first < 0) return cur;
    const on = `enable='between(t,${num(Math.max(0, (first - 0.5) / fps))},${num((last + 0.5) / fps)})'`;

    // The canvas holds the largest posed picture, its smear and its blur.
    const ks = c.kf;
    const turns = ks.some((k) => Math.abs(k.rotation) > 1e-6);
    const diag = 2 * Math.ceil(Math.hypot(boxW, boxH) / 2);
    const grow = Math.max(1, ...ks.map((k) => k.scale));
    const spread = Math.ceil(3 * maxBlur);
    const cw = even((turns ? diag : boxW) * grow + 2 * (Math.ceil(reachX) + spread));
    const ch = even((turns ? diag : boxH) * grow + 2 * (Math.ceil(reachY) + spread));
    const rx = taps >= 2 ? even(reachX + 1) : 0;
    const ry = taps >= 2 ? even(reachY + 1) : 0;
    filters.push(
      `[${cur}]${toAlpha},pad=w=${cw + 2 * rx}:h=${ch + 2 * ry}:x=(ow-iw)/2:y=(oh-ih)/2:color=black@0.0:eval=frame,` +
        `premultiply=inplace=1:${on}[${tag}p]`
    );
    let out = `${tag}p`;

    // The streak: copies at even steps along it, averaged. Outside the
    // window the first copy is the unshifted picture, which mix passes.
    if (taps >= 2) {
      const ex = piecewiseExpr(sx, "t");
      const ey = piecewiseExpr(sy, "t");
      const ins = Array.from({ length: taps }, (_, i) => `[${tag}s${i}]`);
      filters.push(`[${out}]split=${taps}${ins.join("")}`);
      for (let i = 0; i < taps; i++) {
        const f = num(i / (taps - 1) - 0.5);
        filters.push(
          `[${tag}s${i}]crop=${cw}:${ch}:x=${fexpr(`${rx}-(${f})*${ex}`)}:y=${fexpr(`${ry}-(${f})*${ey}`)}[${tag}c${i}]`
        );
      }
      filters.push(`${Array.from({ length: taps }, (_, i) => `[${tag}c${i}]`).join("")}mix=inputs=${taps}:${on}[${tag}m]`);
      out = `${tag}m`;
    }

    // The blur: sigma set on every frame it changes, half a frame early so
    // the command lands on its own frame whatever the rounding.
    let blur = "";
    if (maxBlur > 0) {
      const cmds: string[] = [];
      let prev = -1;
      for (let i = first; i <= last + 1 && i < n; i++) {
        if (blurs[i].v === prev) {
          continue;
        }
        prev = blurs[i].v;
        cmds.push(`${num(Math.max(0, (i - 0.5) / fps))} gblur@${tag} sigma ${num(prev)}`);
      }
      blur = `sendcmd=c='${cmds.join(";")}',gblur@${tag}=sigma=${num(blurs[first].v)}:${on},`;
    }
    filters.push(`[${out}]${blur}unpremultiply=inplace=1:${on}[${tag}o]`);
    return `${tag}o`;
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
      // (an abutting cut), else the bare frame (timeline ends and gaps).
      let bg = fx.bg;
      if (!bg) {
        bg = `xb${tag}_${side}`;
        filters.push(`color=c=${padColor}:s=${w}x${h}:r=${fps}:d=${d},format=${opaqueFmt(fmt)}[${bg}]`);
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
          `[${inLab}]format=${alphaFmt},` +
            `fade=t=${side === "head" ? "in" : "out"}:st=0:d=${d}:alpha=1,${scaleExpr}[${sc}]`
        );
        filters.push(
          `[${bg}][${sc}]overlay=x=(W-w)/2:y=(H-h)/2:shortest=1${ovl},format=${fmt}[${outLab}]`
        );
        return;
      }
      filters.push(`[${inLab}]${scaleExpr}[${sc}]`);
      filters.push(
        `[${bg}][${sc}]overlay=x=(W-w)/2:y=(H-h)/2:shortest=1${ovl},` +
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
    if (a.style === "blur") return { kind: "xfade", secs, xfade: "hblur" };
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

  // Where every clip starts on the timeline. Clips abut and a transition
  // claims no layout, so the running sum is the cut each join happens at.
  const clipAt: number[] = [];
  spec.clips.reduce((acc, c, j) => {
    clipAt[j] = acc;
    return acc + clipDur(c);
  }, 0);
  // Half the cross dissolve at each cut, clamped the way the join clamps its
  // overlap: index j is the crossing between clip j-1 and clip j.
  const crossHalf: number[] = spec.clips.map((_, j) => {
    const prevC = spec.clips[j - 1];
    if (!prevC) return 0;
    const want = prevC.soundCross ?? 0;
    if (want <= 0.01) return 0;
    return Math.min(want, clipAt[j] * 0.9, clipDur(spec.clips[j]) * 0.9);
  });

  // Per-clip normalized video + audio segments for the join below.
  spec.clips.forEach((c, j) => {
    const idx = c.image ? imageClipInput.get(j)! : inputIndex.get(c.file)!;
    const rt = retimeOf(c);
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
    const soundFades = (s: string | undefined) => s === "fade" || s === "blur";
    const ahf = soundFades(animIn?.style) ? Math.min(animIn!.seconds, dur) : 0;
    const atf =
      soundFades(animOut?.style) ? Math.min(animOut!.seconds, Math.max(0, dur - ahf)) : 0;
    if (!headFx && hf <= 0.01 && czHead > 0.01) {
      headFx = { kind: "zoom", secs: Math.min(czHead, dur) };
    }
    if (!tailFx && tf <= 0.01 && czTail > 0.01) {
      tailFx = { kind: "zoom", secs: Math.min(czTail, dur - (headFx?.secs ?? 0)) };
    }
    const rmIn = clipRemovalInput.get(j);
    // A still's looped input is already the right length at `fps`; it has no
    // source span to trim. Footage trims `in..out` and re-times by speed. A
    // removal clip's picture is its uploaded keyed pair instead: the color
    // stream merges its alpha luma, clone-padded so a piece a frame short
    // never shortens the join, and rides the same framing chain in rgba.
    let timebase: string;
    if (rmIn) {
      filters.push(`[${rmIn.a}:v]setpts=PTS-STARTPTS,format=${maskFmt}[rva${j}]`);
      filters.push(`[${gfx(`${rmIn.rgb}:v`)}]setpts=PTS-STARTPTS,${rgbToAlpha}[rvc${j}]`);
      alphaSet(`rvc${j}`, `rva${j}`, `rvs${j}`, `rv${j}`, ",tpad=stop_mode=clone:stop_duration=1");
      timebase = `[rvs${j}]null`;
    } else {
      timebase = c.image
        ? `[${idx}:v]setpts=PTS-STARTPTS`
        : sourceSpan(idx, c, rt);
    }
    if ((c.image || rmIn || videoPresence.get(c.file)) && !c.hidden) {
      const region = regionPx(c.frame, W, H);
      // The keyed layer's letterbox stays transparent (the flatten below lays
      // the frame color behind it), and its alpha survives the chain.
      const segPad = rmIn ? "black@0.0" : padColor;
      const segFmt = rmIn ? alphaHi : clipFmt;
      const plan = rmIn
        ? null
        : colorPlanFor(c, {
            alpha: false,
            hPx: framedPictureHeight(c.file, region ? region.rw : W, region ? region.rh : H, c.fit === "fill", c.zoom),
            interpolated: interpolates(c, rt),
          });
      let frame: string;
      let padding: string;
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
        // The framed picture lands centered in its rect: a covering one fills
        // the rect exactly, a fitted one keeps its margins.
        frame = `${boxFraming(rw, rh, c.fit === "fill", c.zoom, c.panX, c.panY, plan?.flags)}${mirror(c)}`;
        padding = `,pad=${bw}:${bh}:${rx - bx}+(${rw}-iw)/2:${ry - by}+(${rh}-ih)/2:color=${segPad}${win}`;
      } else {
        const cover = c.fit === "fill";
        frame = boxFraming(W, H, cover, c.zoom, c.panX, c.panY, plan?.flags) + mirror(c);
        // A covering picture already spans the frame; a fitted one letterboxes.
        padding = cover ? "" : `,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${segPad}`;
      }
      // setpts/speed rescales the clip's duration on the timeline (footage);
      // a still just replays its looped input. The color runs on the framed
      // picture before the letterbox pad, so the bars stay the frame color.
      let core = framedTimebase(timebase, frame, `c${j}`, rmIn ? {} : c, rt, fps, filters);
      // The picture holds the frames the clip owns before anything paints
      // on it, so a held frame takes its own effects at its own time.
      core += `,${gridHold(segFrames[j].count, fps)}`;
      if (plan) core = plan.run(core, `c${j}`);
      core += `,format=${segFmt}`;
      // The look bakes in after grade + framing, before the edge effects, so
      // animations move already-graded pixels (matching the preview order). A
      // removal clip's look runs after the flatten below instead — the chain's
      // internal blends would drop the keyed layer's alpha. A clip wearing
      // effects takes its look on the picture ahead of the letterbox bars, so
      // the effects can treat the looked picture there, as the preview does.
      const lookAt = (at: string) => {
        if (!c.look || rmIn) return at;
        const lines = lookFilterLines(`lki${j}`, `lko${j}`, c.look, c.lookAmount, H, clipFmt, `c${j}`, depth);
        if (!lines) return at;
        filters.push(`${at}[lki${j}]`);
        filters.push(...lines);
        return `[lko${j}]null`;
      };
      const wears = !!c.effects?.length;
      if (wears) core = wearEffects(lookAt(core), c, dur, W, H, segFmt, `cw${j}`, segLead(j));
      core += padding;
      if (!wears) core = lookAt(core);
      // The border ring lands after the look (true stroke color) and before
      // the fades, so it fades and masks with the clip like the preview.
      const brIdx = clipBorderInput.get(j);
      if (brIdx !== undefined) {
        filters.push(`${core}[cbi${j}]`);
        filters.push(`[cbi${j}][${gfx(`${brIdx}:v`)}]overlay=0:0:eof_action=pass${ovl},format=${segFmt}[cbo${j}]`);
        core = `[cbo${j}]null`;
      }
      // A removal segment carries alpha, so its fades must ramp the alpha
      // plane too — a color-only fade darkens the still-opaque silhouette to
      // black where the preview dissolves it.
      const fadeAlpha = rmIn ? ":alpha=1" : "";
      const fades =
        (hf > 0.01 ? `,fade=t=in:st=0:d=${num(hf)}${fadeAlpha}` : "") +
        (tf > 0.01 ? `,fade=t=out:st=${num(Math.max(0, dur - tf))}:d=${num(tf)}${fadeAlpha}` : "");
      // A neighbor's backdrop animation freezes a frame of this segment —
      // split the copies it needs off the pre-backdrop picture.
      const nFz = (needFirstFreeze[j] ? 1 : 0) + (needLastFreeze[j] ? 1 : 0);
      const segOut = nFz > 0 ? `vseg${j}` : `v${j}`;
      // The shadow is ink the clip's own mask must not reach, so the segment
      // finishes first and the shadow goes over it — outside the clip's shape
      // the segment is bare frame, which is what the shadow would have fallen
      // on anyway.
      const shIdx = clipShadowInput.get(j);
      const segCore = shIdx === undefined ? segOut : `vshi${j}`;
      const mkIdx = clipMaskInput.get(j);
      const subjMask = subjectActive && matteConsumers > 0 ? c.mask?.subject : undefined;
      const keyed = !!c.kf?.length;
      if (mkIdx !== undefined || subjMask || keyed || rmIn) {
        // Masked or keyframed track-0 clip, composed in the preview's order:
        // the painted coverage multiplies first (it rides the clip), the
        // pose transforms and positions the result over a transparent base,
        // the person matte — frame-anchored — trims last, and a black base
        // restores the constant-size opaque frame the join expects. The
        // multiply chains (alphaextract → blend → alphamerge) compose with
        // any alpha the segment carries.
        pushEdgeFx(core, dur, headFx, tailFx, W, H, rmIn ? segAlpha : clipFmt, fades, `vmr${j}`, `c${j}`);
        let cur = `vmr${j}`;
        if (mkIdx !== undefined) {
          filters.push(`[${mkIdx}:v]fps=${fps},scale=${W}:${H},setsar=1,format=${maskFmt}[cmk${j}]`);
          alphaMultiply(cur, `cmk${j}`, `cmc${j}`, `cm${j}`);
          cur = `cmc${j}`;
        } else {
          filters.push(`[${cur}]${videoToAlpha}[cmc${j}]`);
          cur = `cmc${j}`;
        }
        if (keyed) {
          const tf = poseTransformFilters(c.kf!, W, H, segLead(j));
          if (tf) {
            filters.push(`[${cur}]null${tf}[ckt${j}]`);
            cur = `ckt${j}`;
          }
          cur = softenPose(cur, c, dur, W, H, videoToAlpha, `cso${j}`, segLead(j));
          const pos = posePositionExprs(c.kf!, -segLead(j));
          placeOnClear(cur, pos.x, pos.y, dur, `ckb${j}`, `ckp${j}`);
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
          alphaMultiply(cur, `cms${j}`, `csc${j}`, `cs${j}`);
          cur = `csc${j}`;
        }
        // A keyed layer flattens onto the frame color — where the removal
        // left the picture transparent, the export shows what the preview
        // shows behind track 0.
        filters.push(
          `color=c=${rmIn ? padColor : "black"}:s=${W}x${H}:r=${fps}:d=${num(dur)}[cmb${j}]`
        );
        const flatOut = rmIn && c.look ? `vrl${j}` : segCore;
        filters.push(
          `[cmb${j}][${cur}]overlay=0:0:shortest=1${ovl},format=${clipFmt},fps=${fps}[${flatOut}]`
        );
        if (flatOut !== segCore) {
          // The removal clip's look, over the flattened opaque segment.
          const lines = lookFilterLines(`vrl${j}`, segCore, c.look!, c.lookAmount, H, clipFmt, `cr${j}`, depth);
          if (lines) filters.push(...lines);
          else filters.push(`[vrl${j}]null[${segCore}]`);
        }
      } else {
        pushEdgeFx(core, dur, headFx, tailFx, W, H, clipFmt, fades, segCore, `c${j}`);
      }
      if (shIdx !== undefined) {
        filters.push(`[${gfx(`${shIdx}:v`)}]fps=${fps},scale=${W}:${H},setsar=1,${rgbToAlpha}[csh${j}]`);
        filters.push(
          `[${segCore}][csh${j}]overlay=0:0:eof_action=pass${ovl},format=${clipFmt},fps=${fps}[${segOut}]`
        );
      }
      if (nFz > 0) {
        filters.push(
          `[vseg${j}]split=${nFz + 1}[v${j}]` +
            (needFirstFreeze[j] ? `[vff${j}]` : "") +
            (needLastFreeze[j] ? `[vfl${j}]` : "")
        );
      }
    } else {
      // No video stream, or a hidden clip: the slot plays the bare frame — an
      // elements-only cut is one such slot for its whole length. trim+setpts
      // clear the frame-rate stamp a transitioned join's xfade demands —
      // re-stamp it.
      filters.push(
        `color=c=${padColor}:s=${W}x${H}:r=${fps},trim=0:${num(dur)},setpts=PTS-STARTPTS,fps=${fps},format=${clipFmt}[v${j}]`
      );
    }
    const snd = sounding(c);
    if (!c.muted && !c.hidden && snd && audioPresence.get(snd.file)) {
      const vol = `${soundChain(c.sound)}${(c.volume ?? 1) !== 1 ? `volume=${num(c.volume ?? 1)},` : ""}`;
      // The picture's fade edges carry the sound with them; zoom edges don't.
      const afades =
        (ahf > 0.01 ? `,afade=t=in:st=0:d=${num(ahf)}` : "") +
        (atf > 0.01 ? `,afade=t=out:st=${num(Math.max(0, dur - atf))}:d=${num(atf)}` : "") +
        // A cross dissolve is not a fade: it ramps equal-power past the clip
        // on the other side of the cut, reaching half level there rather than
        // silence, which is why it is a volume expression and not afade.
        crossFilters([
          crossExpr(0, crossHalf[j], true),
          crossExpr(dur, crossHalf[j + 1] ?? 0, false),
        ]);
      filters.push(
        audioRead(snd, 0, dur) +
          `${toStereo(snd.file)}${vol}` +
          `apad=whole_dur=${num(dur)},atrim=0:${num(dur)}${afades}[a${j}]`
      );
    } else {
      filters.push(
        `anullsrc=r=${MIX_RATE}:cl=stereo,atrim=0:${num(dur)},asetpts=PTS-STARTPTS[a${j}]`
      );
    }
  });

  // Second pass: the backdrop animations. Each slices its edge window and
  // runs the effect against the neighbor's held frame — frozen via tpad
  // clone from the copies split off above, so a slide-in covers the previous
  // clip's last frame and a slide-out reveals the next clip's first frame.
  // Slides become cover/reveal (the backdrop stays put); pop alpha-blends
  // over the frozen frame; blur defocuses across it; fade — and any unknown
  // stored style — crossfades.
  const segLabel = spec.clips.map((_, j) => `v${j}`);
  const backdropFx = (
    a: { style: string; seconds: number },
    side: "head" | "tail",
    secs: number,
    bg: string
  ): EdgeFx => {
    if (a.style === "pop") return { kind: "pop", secs, bg };
    if (a.style === "blur") return { kind: "xfade", secs, xfade: "hblur", bg };
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

  // The handles a cross dissolve reaches into. A concat cannot have two
  // segments sounding at once, and the whole point of a crossing is that they
  // do: so the stretch each clip plays past its own footprint — the outgoing
  // one after the cut, the incoming one before it — is lifted out as its own
  // delayed stream and mixed in beside the joined clip audio. Its ramp
  // carries on from where the segment's left off, at half level on the cut.
  const crossHandleLabels: string[] = [];
  const handleStream = (
    src: (typeof spec.clips)[number],
    key: string,
    fromT: number,
    toT: number,
    at: number,
    expr: string
  ) => {
    if (toT - fromT <= 0.01 || src.muted || src.hidden || src.image) return;
    const snd = sounding(src);
    if (!snd || !audioPresence.get(snd.file)) return;
    const lab = `xh${key}`;
    filters.push(
      audioRead(snd, fromT, toT) +
        toStereo(snd.file) +
        `${soundChain(src.sound)}` +
        `${(src.volume ?? 1) !== 1 ? `volume=${num(src.volume ?? 1)},` : ""}anull${crossFilters([expr])},` +
        `adelay=${Math.max(0, Math.round(at * 1000))}:all=1[${lab}]`
    );
    crossHandleLabels.push(lab);
  };
  spec.clips.forEach((c, j) => {
    const half = crossHalf[j];
    const prevC = spec.clips[j - 1];
    if (half <= 0.01 || !prevC) return;
    const cut = clipAt[j];
    const ahead = Math.min(prevC.soundAhead ?? 0, half);
    // Never reach past the head of the source: a handle is what the trim left
    // behind, and there is none before zero.
    const back = Math.min(c.soundBack ?? 0, half, headRoom(sounding(c) ?? c));
    // The outgoing clip, still sounding past its out point.
    const prevDur = clipDur(prevC);
    handleStream(prevC, `a${j}`, prevDur, prevDur + ahead, cut, crossExpr(0, half, false));
    // The incoming clip, already sounding before its in point.
    handleStream(c, `b${j}`, -back, 0, cut - back, crossExpr(back, half, true));
  });
  // A split edit: a clip's sound ahead of its picture (J-cut) or carried on
  // past it (L-cut), lifted out the same way and ramped from silence at its
  // far end. A transition at that cut owns the handover, so it has none.
  spec.clips.forEach((c, j) => {
    const fade = c.splitFade ?? 0;
    const lead = Math.min(c.soundLead ?? 0, c.soundBack ?? 0, headRoom(sounding(c) ?? c), clipAt[j]);
    if (lead > 0.01) handleStream(c, `l${j}`, -lead, 0, clipAt[j] - lead, splitExpr(0, lead, fade, true));
    const tail = Math.min(c.soundTail ?? 0, c.soundAhead ?? 0);
    const dur = clipDur(c);
    if (tail > 0.01) handleStream(c, `t${j}`, dur, dur + tail, clipAt[j] + dur, splitExpr(0, tail, fade, false));
  });

  // Join the segments. Clips abut — a transition claims no layout — so every
  // join keeps the accumulator's full length. A transitioned join pads the
  // incoming segment's head with its cloned first frame and runs the xfade
  // across the outgoing clip's last blend-window seconds: the held frame
  // arrives over the live tail, and the real segment starts exactly at the
  // cut. Its sound is a tail fade on the outgoing side and a hard join. A
  // cross dissolve cuts the picture and crosses the sound instead — a tail
  // fade against the incoming clip's head fade. The rest hard-cut (concat).
  // Fold left so mixed sequences chain correctly.
  // Each segment is held to the frames it owns, so every cut lands on the
  // frame the preview cuts on and a short clip never shifts the rest.
  spec.clips.forEach((_, j) => {
    filters.push(
      `[${segLabel[j]}]${gridHold(segFrames[j].count, fps)}[vg${j}]`
    );
    segLabel[j] = `vg${j}`;
  });
  // A run of joins that concat — hard cuts and cross dissolves, whose sound
  // crosses on its own streams — is one concat over the whole run. A chain
  // of two-way concats would hold every frame handed to a segment it has not
  // reached at each link it waits behind, so its memory grew with the cut
  // count; one concat reads its segments in turn. concat emits a microsecond
  // timebase with no frame-rate stamp, and a later transitioned join hands
  // the run to xfade, which demands both inputs carry the same 1/fps stamp —
  // re-stamp it.
  let runV = [segLabel[0]];
  let runA = ["a0"];
  const joinRun = (j: number): [string, string] => {
    if (runV.length === 1) {
      return [runV[0], runA[0]];
    }
    filters.push(`${runV.map((l) => `[${l}]`).join("")}concat=n=${runV.length}:v=1:a=0,fps=${fps}[vj${j}]`);
    filters.push(`${runA.map((l) => `[${l}]`).join("")}concat=n=${runA.length}:v=0:a=1[aj${j}]`);
    return [`vj${j}`, `aj${j}`];
  };
  // Running timeline length of the accumulator, on the frame grid.
  const gridEnd = (j: number) => (segFrames[j].first + segFrames[j].count) / fps;
  let acc = gridEnd(0);
  for (let j = 1; j < spec.clips.length; j++) {
    const prev = spec.clips[j - 1];
    const durJ = clipDur(spec.clips[j]);
    // The blend can't exceed most of either clip, matching the editor clamp.
    const d = Math.min(prev.transition ?? 0, acc * 0.9, durJ * 0.9);
    const cross = Math.min(prev.soundCross ?? 0, acc * 0.9, durJ * 0.9);
    if (cross > 0.01 || d <= 0.01) {
      // The picture cuts: the segment joins the run. A cross dissolve's sound
      // ramps are already on the two segments, and the halves that reach
      // past the cut ride their own streams into the mix.
      runV.push(segLabel[j]);
      runA.push(`a${j}`);
    } else {
      const [vAcc, aAcc] = joinRun(j - 1);
      const offset = Math.max(0, acc - d);
      // The style id resolves through the allowlist map; anything unknown
      // (or an old spec without a style) renders as a plain fade. The shaped
      // and softened styles come back as xfade expressions.
      const kind = xfadeTransition(prev.transitionStyle, prev.transitionFeather, d, W, H);
      filters.push(`[${segLabel[j]}]tpad=start_duration=${num(d)}:start_mode=clone[vh${j}]`);
      filters.push(`[${vAcc}][vh${j}]xfade=${kind}:duration=${num(d)}:offset=${num(offset)}[vx${j}]`);
      filters.push(`[${aAcc}]afade=t=out:st=${num(offset)}:d=${num(d)}[ah${j}]`);
      filters.push(`[ah${j}][a${j}]concat=n=2:v=0:a=1[ax${j}]`);
      runV = [`vx${j}`];
      runA = [`ax${j}`];
    }
    acc = gridEnd(j);
  }
  const [vAcc, aAcc] = joinRun(spec.clips.length - 1);

  // Composite the video stack bottom→top: the overlay tracks draw over the
  // track-0 base in track order. A full-frame layer covers; a regioned one
  // shares the frame (split half) or floats (PiP). Overlay audio (unless
  // muted) mixes in below.
  const overlaySoundLabels: string[] = [];
  let ovk = 0;
  // Overlay one track clip onto `onto`, returning the new label; also queues
  // its audio.
  const addOverlay = (oc: (typeof overlayVideos)[number], onto: string): string => {
    const orIn = overlayRemovalInput.get(oc);
    if (!oc.image && !orIn && !videoPresence.get(oc.file)) return onto;
    const idx = oc.image ? imageOverlayInput.get(oc)! : inputIndex.get(oc.file)!;
    const ort = retimeOf(oc);
    const olen = spanLen(oc);
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
    // A cross dissolve's own ramps: the sound crosses at the cut, the picture
    // cuts with it.
    const hs = Math.max(0, Math.min(oc.headSound ?? 0, olen));
    const ts = Math.max(0, Math.min(oc.tailSound ?? 0, olen - hs));
    const ramped = hz > 0.01 || tz > 0.01;
    const maskIdx = overlayMaskInput.get(oc);
    const subjMask = subjectActive && matteConsumers > 0 ? oc.mask?.subject : undefined;
    const keyed = !!oc.kf?.length;
    const boxW = region ? region.rw : W;
    const boxH = region ? region.rh : H;
    // The overlay's picture meets its box the same way a track-0 clip meets
    // the frame; whatever the box does not swallow sits centered in it.
    const plan = orIn
      ? null
      : colorPlanFor(oc, {
          alpha: !!oc.image,
          hPx: framedPictureHeight(oc.file, boxW, boxH, cover, oc.zoom),
          interpolated: interpolates(oc, ort),
        });
    const framing = boxFraming(boxW, boxH, cover, oc.zoom, oc.panX, oc.panY, plan?.flags) + mirror(oc);
    let pos: string;
    if (!region) {
      pos = cover ? "0:0" : `x=(${W}-w)/2:y=(${H}-h)/2`;
    } else {
      const { rx, ry, rw, rh } = region;
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
      ? `,format=${alphaFmt},pad=${boxW}:${boxH}:(ow-iw)/2:(oh-ih)/2:color=black@0.0`
      : "";
    if (boxed) pos = region ? `${region.rx}:${region.ry}` : "0:0";
    const fmt = hf > 0.01 || tf > 0.01 || boxed || orIn ? alphaFmt : clipFmt;
    // The look chain reads the pre-pad picture, which is opaque.
    const lookFmt = boxed ? clipFmt : fmt;
    const fades =
      (hf > 0.01 ? `,fade=t=in:st=0:d=${num(hf)}:alpha=1` : "") +
      (tf > 0.01 ? `,fade=t=out:st=${num(Math.max(0, olen - tf))}:d=${num(tf)}:alpha=1` : "");
    const k = ovk++;
    const seg = `ovv${k}`;
    // A still replays its looped input; footage trims its source span and
    // re-times by speed. tpad then delays the clip to its timeline start. A
    // removal overlay's picture is its uploaded keyed pair, alpha merged in
    // and clone-padded, grade and look already baked into the pixels.
    let timebase: string;
    if (orIn) {
      filters.push(`[${orIn.a}:v]setpts=PTS-STARTPTS,format=${maskFmt}[ova${k}]`);
      filters.push(`[${gfx(`${orIn.rgb}:v`)}]setpts=PTS-STARTPTS,${rgbToAlpha}[ovc${k}]`);
      alphaSet(`ovc${k}`, `ova${k}`, `ovr${k}`, `ov${k}`, ",tpad=stop_mode=clone:stop_duration=1");
      timebase = `[ovr${k}]null`;
    } else {
      timebase = oc.image
        ? `[${idx}:v]setpts=PTS-STARTPTS`
        : sourceSpan(idx, oc, ort);
    }
    let core = framedTimebase(timebase, framing, `o${k}`, orIn ? {} : oc, ort, fps, filters);
    if (plan) core = plan.run(core, `o${k}`);
    core += `,format=${orIn ? alphaFmt : lookFmt}`;
    // Looks bake into footage overlays only: an image may carry alpha, which
    // the look chain's internal filters would flatten onto black over the
    // tracks beneath. The alpha fades stay safe: they apply after the look.
    if (oc.look && !oc.image && !orIn) {
      const lines = lookFilterLines(`olki${k}`, `olko${k}`, oc.look, oc.lookAmount, H, lookFmt, `o${k}`, depth);
      if (lines) {
        filters.push(`${core}[olki${k}]`);
        filters.push(...lines);
        core = `[olko${k}]null`;
      }
    }
    // Seconds from the element's start to its first frame on the grid.
    const ovLead = gridFrame(oc.start, fps) / fps - oc.start;
    core = wearEffects(core, oc, olen, boxW, boxH, lookFmt, `ow${k}`, ovLead);
    if (boxPad) core += boxPad;
    // The border ring lands after the look and box pad, before the edge
    // ramps, so it fades and masks with the clip like the preview.
    const obIdx = overlayBorderInput.get(oc);
    if (obIdx !== undefined) {
      filters.push(`${core}[obi${k}]`);
      filters.push(`[obi${k}][${gfx(`${obIdx}:v`)}]overlay=0:0:eof_action=pass${ovl},format=${fmt}[obo${k}]`);
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
      filters.push(`[${maskIdx}:v]fps=${fps},scale=${boxW}:${boxH},setsar=1,format=${maskFmt}[omk${k}]`);
      alphaMultiply(pre, `omk${k}`, `omc${k}`, `om${k}`, `,format=${alphaFmt}`);
      masked = `omc${k}`;
    }
    if (keyed) {
      const tf = poseTransformFilters(oc.kf!, boxW, boxH, ovLead);
      if (tf) {
        filters.push(`[${masked}]${videoToAlpha}${tf},format=${alphaFmt}[okt${k}]`);
        masked = `okt${k}`;
      }
      masked = softenPose(masked, oc, olen, boxW, boxH, `format=${alphaFmt}`, `oso${k}`, ovLead);
    }
    // The clip's first frame is the first one at or after its start, as on
    // track 0. The zoom slices' concat drops the stream's frame-rate
    // metadata, so the fps re-stamp keeps tpad's frames on the grid.
    filters.push(`[${masked}]fps=${fps},tpad=start=${gridFrame(oc.start, fps)}[${seg}]`);
    const next = `vovv${k}`;
    const enable = `enable='between(t,${edge(oc.start)},${edge(end)})'`;
    // The shadow falls on whatever is already there, then the clip goes down
    // over it. Its silhouette is punched out, so the two never fight.
    const oshIdx = overlayShadowInput.get(oc);
    if (oshIdx !== undefined) {
      const lit = `ovsh${k}`;
      filters.push(
        `[${gfx(`${oshIdx}:v`)}]fps=${fps},scale=${W}:${H},setsar=1,${rgbToAlpha},` +
          `tpad=start_duration=${num(oc.start)}:color=black@0.0[${lit}]`
      );
      const shOnto = `vovs${k}`;
      filters.push(`[${onto}][${lit}]overlay=0:0:${enable}:eof_action=pass${ovl}[${shOnto}]`);
      onto = shOnto;
    }
    if (subjMask) {
      // Subject-masked overlay clip: the delayed segment lands on the full
      // frame at its spot — a static pad, or an expression overlay onto a
      // transparent base when keyed — its alpha multiplies by the timeline-
      // aligned matte, and the trimmed layer composites at the origin.
      const matte = nextMatte(`bso${k}`, subjMask);
      if (keyed) {
        const kpos = posePositionExprs(oc.kf!, oc.start);
        placeOnClear(seg, kpos.x, kpos.y, spec.duration, `osb${k}`, `osp${k}`);
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
          `[${seg}]${videoToAlpha},pad=${bw}:${bh}:${padX - bx}:${padY - by}:color=black@0.0${win}[osp${k}]`
        );
      }
      alphaMultiply(`osp${k}`, matte, `osc${k}`, `os${k}`, `,format=${alphaFmt}`);
      filters.push(`[${onto}][osc${k}]overlay=0:0:${enable}:eof_action=pass${ovl}[${next}]`);
    } else if (keyed) {
      const kpos = posePositionExprs(oc.kf!, oc.start);
      filters.push(
        `[${onto}][${seg}]overlay=x=${kpos.x}:y=${kpos.y}:${enable}:eof_action=pass${ovl}[${next}]`
      );
    } else {
      filters.push(`[${onto}][${seg}]overlay=${pos}:${enable}:eof_action=pass${ovl}[${next}]`);
    }
    const osnd = sounding(oc);
    if (!oc.muted && osnd && audioPresence.get(osnd.file)) {
      const vol = (oc.volume ?? 1) !== 1 ? `volume=${num(oc.volume ?? 1)},` : "";
      // A cross dissolve or a split edit reaches into the handle either side
      // of the clip, so this stream starts before its own head and runs past
      // its tail; everything timed inside it shifts by that head reach.
      const lead = Math.min(oc.soundLead ?? 0, oc.start);
      const back = Math.min(oc.soundBack ?? 0, Math.max(hs, lead), headRoom(osnd));
      const ahead = Math.min(oc.soundAhead ?? 0, Math.max(ts, oc.soundTail ?? 0));
      const splitIn = Math.min(lead, back);
      const splitOut = Math.min(oc.soundTail ?? 0, ahead);
      // The picture's fade edges carry the sound with them; zoom edges don't.
      // A cross dissolve's ramps are equal-power and reach half level on the
      // cut, so they are a volume expression rather than a fade to silence.
      const afades =
        (hf > 0.01 ? `afade=t=in:st=${num(back)}:d=${num(hf)},` : "") +
        (tf > 0.01
          ? `afade=t=out:st=${num(Math.max(0, back + olen - tf))}:d=${num(tf)},`
          : "");
      const crosses = crossFilters([
        crossExpr(back, hs, true),
        crossExpr(back + olen, ts, false),
        splitIn > 0.01 ? splitExpr(back - splitIn, splitIn, oc.splitFade ?? 0, true) : "",
        splitOut > 0.01 ? splitExpr(back + olen, splitOut, oc.splitFade ?? 0, false) : "",
      ]);
      const delayMs = Math.max(0, Math.round((oc.start - back) * 1000));
      const lab = `ovs${k}`;
      filters.push(
        audioRead(osnd, -back, olen + ahead) +
          toStereo(osnd.file) +
          `${soundChain(oc.sound)}${vol}${afades}anull` +
          `${crosses},adelay=${delayMs}:all=1[${lab}]`
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
        // The slideshow is a handful of stills, so the conversion, the pad
        // and the alpha extraction run on those stills and `fps` duplicates
        // references afterwards; the per-frame work is the matte blend, paced
        // by the matte.
        const matte = nextMatte(`bse${k}`, o.subject);
        filters.push(
          `[${gfx(`${animIdx}:v`)}]${rgbToAlpha},` +
            `pad=${W}:${H}:${num(o.x ?? 0)}:${num(o.y ?? 0)}:color=black@0.0,setsar=1[oep${k}]`
        );
        if (hdr) {
          filters.push(`[oep${k}]fps=${fps}[oef${k}]`);
          alphaMultiply(`oef${k}`, matte, `oes${k}`, `oe${k}`, `,format=${alphaFmt}`);
        } else {
          filters.push(`[oep${k}]split[oe0${k}][oe1${k}]`);
          filters.push(`[oe0${k}]fps=${fps}[oef${k}]`);
          filters.push(`[oe1${k}]alphaextract,fps=${fps}[oea${k}]`);
          filters.push(`[oea${k}][${matte}]blend=all_mode=multiply[oem${k}]`);
          filters.push(`[oef${k}][oem${k}]alphamerge,format=${alphaFmt}[oes${k}]`);
        }
        filters.push(`[${onto}][oes${k}]overlay=0:0:eof_action=pass${ovl}[${next}]`);
        return next;
      }
      filters.push(`[${gfx(`${animIdx}:v`)}]format=${alphaFmt},fps=${fps},setsar=1[oanim${k}]`);
      filters.push(
        `[${onto}][oanim${k}]overlay=${num(o.x ?? 0)}:${num(o.y ?? 0)}:eof_action=pass${ovl}[${next}]`
      );
    } else if (o.file) {
      const idx = inputIndex.get(o.file)!;
      filters.push(
        `[${onto}][${gfx(`${idx}:v`)}]overlay=0:0:enable='gte(t,${edge(o.start)})*lt(t,${edge(o.end)})'${ovl}[${next}]`
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
    .filter(({ e }) => !isAudioEffect(e.effect))
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
      effectRecipe(e),
      e.amount,
      Math.max(0, e.start),
      Math.min(e.end, spec.duration),
      spec.width,
      spec.height,
      `fx${i}`,
      e.focus,
      e.ramp,
      chroma,
      e
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
    filters.push(`[${gfx(`${idx}:v`)}]format=${alphaFmt},fps=${fps},setsar=1[caps${k}]`);
    filters.push(`[${vLabel}][caps${k}]overlay=0:0:eof_action=pass${ovl}[vcaps${k}]`);
    vLabel = `vcaps${k}`;
  });

  // Voiceover ducking: while a ducking clip plays, every other sound drops to
  // its gain. The windows are timeline seconds, so the volume automation must
  // run on timeline-aligned streams — the joined clip audio, and each other
  // sound *after* its adelay.
  const duckWindows = spec.audio
    .filter((a) => a.duck !== undefined && a.duck < 1)
    .map((a) => {
      const len = spanLen(a);
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
  /** The lane of each entry in soundLabels, for the stems. */
  const soundLanes: number[] = [];
  spec.audio.forEach((a, k) => {
    if (!audioPresence.get(a.file)) return;
    const delayMs = Math.max(0, Math.round(a.start * 1000));
    // Timeline length after any speed change; fade offsets are in these
    // (post-tempo) seconds, so the tempo runs before the fades.
    const len = spanLen(a);
    const fades: string[] = [];
    if (a.fadeIn && a.fadeIn > 0.01) fades.push(`afade=t=in:st=0:d=${num(a.fadeIn)}`);
    if (a.fadeOut && a.fadeOut > 0.01)
      fades.push(`afade=t=out:st=${num(Math.max(0, len - a.fadeOut))}:d=${num(a.fadeOut)}`);
    filters.push(
      audioRead(a, 0, len) +
        toStereo(a.file) +
        `${soundChain(a.sound)}volume=${num(a.volume)},` +
        (fades.length ? fades.join(",") + "," : "") +
        `adelay=${delayMs}:all=1[snd${k}]`
    );
    // Music and other non-voiceover sound ducks under the voiceovers.
    soundLabels.push(a.duck !== undefined && a.duck < 1 ? `snd${k}` : duckOthers(`snd${k}`));
    soundLanes.push(a.lane ?? 0);
  });

  // The joined clip audio and overlay-video audio duck too.
  let aLabel = duckOthers(aAcc);
  const overlayDucked = overlaySoundLabels.map(duckOthers);
  const crossDucked = crossHandleLabels.map(duckOthers);
  // Stems hear a split of the very streams the mix sums — ducked, faded,
  // treated — so adding them back up gives the mix.
  const stemPlan = spec.stemPlan ?? [];
  const stemInputs: string[][] = stemPlan.map(() => []);
  const dialogueStem = stemPlan.findIndex((s) => s.lane === null);
  const tap = (label: string, stem: number): string => {
    if (stem < 0) return label;
    filters.push(`[${label}]asplit=2[${label}m][${label}s]`);
    stemInputs[stem].push(`${label}s`);
    return `${label}m`;
  };
  aLabel = tap(aLabel, dialogueStem);
  const extraSound = [
    ...soundLabels.map((l, i) => tap(l, stemPlan.findIndex((s) => s.lane === soundLanes[i]))),
    ...overlayDucked.map((l) => tap(l, dialogueStem)),
    ...crossDucked.map((l) => tap(l, dialogueStem)),
  ];
  if (extraSound.length > 0) {
    const mixIn = [aLabel, ...extraSound].map((l) => `[${l}]`).join("");
    filters.push(
      `${mixIn}amix=inputs=${extraSound.length + 1}:duration=first:dropout_transition=0:normalize=0[amix]`
    );
    aLabel = "amix";
  }

  // Audio effect elements treat the finished mix over their own windows: the
  // window is cut out of the stream, run through the effect's chain, and put
  // back between the untreated pieces. The treated piece is padded and
  // trimmed back to the length it went in at, so a chain that rings past its
  // input cannot push the rest of the sound late.
  // The same treatment runs on every stem, each labelled by its own `tag`.
  const treatAudio = (input: string, tag: string): string => {
    let label = input;
    (spec.effects ?? [])
      .filter((e) => isAudioEffect(e.effect))
      .sort((a, b) => a.start - b.start)
      .forEach((e, n) => {
        const k = `${tag}${n}`;
        const chain = audioFxFilters(e.effect, e.amount);
        const from = Math.max(0, e.start);
        const to = Math.min(e.end, spec.duration);
        if (!chain || !(to > from)) return;
        const len = to - from;
        const fit = `${chain},apad=whole_dur=${num(len)},atrim=0:${num(len)},asetpts=PTS-STARTPTS`;
        const head = from > 0.001;
        const tail = to < spec.duration - 0.001;
        // An effect covering the whole mix is the chain itself; nothing to splice.
        if (!head && !tail) {
          filters.push(`[${label}]${fit}[afx${k}]`);
          label = `afx${k}`;
          return;
        }
        const branches = 1 + (head ? 1 : 0) + (tail ? 1 : 0);
        filters.push(
          `[${label}]asplit=${branches}` +
            (head ? `[afxsh${k}]` : "") +
            `[afxsw${k}]` +
            (tail ? `[afxst${k}]` : "")
        );
        const parts: string[] = [];
        if (head) {
          filters.push(`[afxsh${k}]atrim=0:${num(from)},asetpts=PTS-STARTPTS[afxh${k}]`);
          parts.push(`afxh${k}`);
        }
        filters.push(
          `[afxsw${k}]atrim=${num(from)}:${num(to)},asetpts=PTS-STARTPTS,${fit}[afxw${k}]`
        );
        parts.push(`afxw${k}`);
        if (tail) {
          filters.push(`[afxst${k}]atrim=start=${num(to)},asetpts=PTS-STARTPTS[afxt${k}]`);
          parts.push(`afxt${k}`);
        }
        filters.push(
          `${parts.map((l) => `[${l}]`).join("")}concat=n=${parts.length}:v=0:a=1[afx${k}]`
        );
        label = `afx${k}`;
      });
    return label;
  };
  aLabel = treatAudio(aLabel, "");

  // A PQ delivery: the finished HLG composite through the BT.2100 OOTF at
  // 1000 nits and the ST 2084 curve, one fixed lattice, then back to video.
  if (output === "pq") {
    const file = path.join(job.tmpDir, "hlg_to_pq.cube");
    await io.writeFile(file, lutToCube(buildTransferLut(spec.lutSizeWide ?? 65, hlgToPq), "HLG to PQ"));
    filters.push(
      `[${vLabel}]scale=in_color_matrix=bt2020:in_range=tv,format=gbrp16le,lut3d=file=${fexpr(file)}:interp=tetrahedral,` +
        `scale=out_color_matrix=bt2020:out_range=tv,format=${clipFmt}[vpq]`
    );
    vLabel = "vpq";
  }
  filters.push(`[${vLabel}]${colorParamsFilter(spec)}[vtag]`);
  vLabel = "vtag";

  // A range is cut from the finished composite, so it carries what the
  // timeline shows there — fades, captions, and elements in place.
  const span = deliverySpan(spec.range, spec.duration);
  if (spec.range) {
    const from = num(Math.max(0, spec.range.start));
    const to = num(Math.min(spec.duration, spec.range.end));
    filters.push(`[${vLabel}]trim=start=${from}:end=${to},setpts=PTS-STARTPTS[vrange]`);
    vLabel = "vrange";
    // The sound takes the delivery's rate before the cut, so a range starts
    // on the whole delivery's sample grid: ranges laid end to end are the
    // samples one pass would write.
    filters.push(
      `[${aLabel}]aresample=${spec.audioSampleRate ?? MIX_RATE},atrim=start=${from}:end=${to},asetpts=PTS-STARTPTS[arange]`
    );
    aLabel = "arange";
  }

  // Each stem: its streams summed, treated like the mix, and laid over the
  // delivery's whole length so every file starts and ends where it does.
  const stemLabels = stemPlan.map((_, i) => {
    const ins = stemInputs[i];
    let label = `stm${i}`;
    if (ins.length === 0) filters.push(`anullsrc=r=${MIX_RATE}:cl=stereo,atrim=0:${num(spec.duration)}[${label}]`);
    else if (ins.length === 1) label = ins[0];
    else {
      filters.push(
        `${ins.map((l) => `[${l}]`).join("")}amix=inputs=${ins.length}:duration=longest:dropout_transition=0:normalize=0[${label}]`
      );
    }
    label = treatAudio(label, `s${i}_`);
    const window = spec.range
      ? `,aresample=${STEM_RATE},atrim=start=${num(Math.max(0, spec.range.start))}:end=${num(Math.min(spec.duration, spec.range.end))},asetpts=PTS-STARTPTS`
      : "";
    filters.push(`[${label}]apad=whole_dur=${num(spec.duration)},atrim=0:${num(spec.duration)}${window}[stem${i}]`);
    return `stem${i}`;
  });
  if (stemPlan.length > 0 && !job.stemsPath) throw new Error("This export has nowhere to put its stems.");
  const stemFiles = stemPlan.map((s, i) => ({
    path: out.kind === "piece" ? out.stems[i] : path.join(job.tmpDir, `stem_${i}.wav`),
    name: s.file,
  }));
  // A piece's sound ends where its range trim ends it: the trim cuts on the
  // millisecond edges the next piece starts from, and a length rounded on
  // its own would drop the samples between them.
  const soundLength = out.kind === "piece" ? [] : ["-t", num(span)];
  const stemOutputs = stemLabels.flatMap((label, i) => [
    "-map", `[${label}]`,
    "-c:a", "pcm_s24le",
    "-ar", String(STEM_RATE),
    "-ac", String(STEM_CHANNELS),
    ...soundLength,
    stemFiles[i].path,
  ]);

  // A mastered delivery takes its sound out of this pass as raw float, so the
  // master can run the tab's own loudness code over it before it is encoded.
  // The raw mix comes out in the delivery's own rate and layout, so the
  // master weighs the same channels the tab's master does: a mono delivery
  // is measured as mono, a 5.1 one with its surround weights.
  // A piece's mix always comes out raw: the pieces' samples laid end to end
  // are the delivery's mix, mastered or encoded once at the join.
  const master = spec.loudness !== undefined;
  if (master && spec.truePeakCeiling === undefined) throw new Error("A mastered export needs its true-peak ceiling.");
  const rawMix = master || out.kind === "piece";
  const mixPath = out.kind === "piece" ? out.mix : path.join(job.tmpDir, "mix.f32");
  const mixRate = spec.audioSampleRate ?? MIX_RATE;
  const mixChannels = spec.audioChannels ?? 2;

  const enc = await io.videoEncoder(spec.codec ?? "h264");

  // Encode into the tmp dir, then re-emit the container to strip a stray output
  // rotation flag (see the strip pass below). Keeping the encode intermediate
  // lets the second pass own faststart.
  const encodePath = out.kind === "piece" ? out.video : path.join(job.tmpDir, `encode${containerExtension(spec)}`);
  const [shareFrom, shareTo] = out.kind === "piece" ? out.progress : [0, 1];
  await io.runFfmpeg(
    job,
    [
      "-y",
      ...inputs,
      "-filter_complex", assertGraphSafe(fanOutInputs(filters).join(";")),
      "-map", `[${vLabel}]`,
      ...(rawMix ? [] : ["-map", `[${aLabel}]`]),
      ...videoCodecArgs(enc, spec),
      ...colorTagArgs(spec),
      ...(rawMix ? [] : audioCodecArgs(spec)),
      "-t", num(span),
      encodePath,
      ...(rawMix
        ? ["-map", `[${aLabel}]`, "-c:a", "pcm_f32le", "-ar", String(mixRate), "-ac", String(mixChannels), "-f", "f32le", ...soundLength, mixPath]
        : []),
      ...stemOutputs,
    ],
    (t) => (job.progress = Math.min(0.99, shareFrom + (shareTo - shareFrom) * (t / Math.max(0.1, span))))
  );

  // A piece is done once its files are written; the join masters, packs and
  // muxes the whole.
  if (out.kind === "piece") {
    return;
  }

  // The master and the stems pack run in this process, out of a cancel's
  // reach, so the job is checked after each: a canceled render never goes on
  // to write its file.
  const masteredPath = path.join(job.tmpDir, "master.f32");
  if (master) {
    await io.masterRawMix([mixPath], masteredPath, {
      sampleRate: mixRate,
      channels: mixChannels,
      targetLufs: spec.loudness!,
      ceilingDbtp: spec.truePeakCeiling!,
    });
    stopIfCanceled(job);
  }
  if (stemPlan.length > 0) {
    await io.packStems(stemFiles, job.stemsPath!);
    stopIfCanceled(job);
  }

  // ffmpeg's autorotation already baked each source's display matrix into the
  // pixels, so the encode's frames are upright. But for a complex filtergraph it
  // ALSO copies the first input's display-matrix side data onto the output
  // stream — so a phone (portrait) source lands as a correct 1080×1920 file
  // tagged with a stray 90° rotation, and players re-rotate it into a sideways
  // "desktop" frame. `-display_rotation 0` overrides that matrix to identity; a
  // stream copy re-emits the (already correct) pixels and audio unchanged and
  // writes the faststart-optimized final file.
  // A mastered mix joins the picture here, encoded for the delivery.
  await io.runFfmpeg(job, [
    "-y",
    "-display_rotation", "0",
    "-i", encodePath,
    ...(master
      ? [
          "-f", "f32le", "-ar", String(mixRate), "-ac", String(mixChannels), "-i", masteredPath,
          "-map", "0:v", "-map", "1:a", "-c:v", "copy", ...audioCodecArgs(spec), "-t", num(span),
        ]
      : ["-map", "0", "-c", "copy"]),
    "-movflags", "+faststart",
    job.outPath,
  ]);

  job.progress = 1;
}

/** An ffconcat list of pieces laid end to end, each held for its window's
 * length so the next starts on the frame the last one stopped short of. */
function pieceList(pieces: { file: string; seconds: number }[]): string {
  const lines = ["ffconcat version 1.0"];
  for (const p of pieces) {
    lines.push(`file '${p.file}'`, `duration ${edge(p.seconds)}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Render `given` window by window and join the pieces into the delivery.
 *
 * Each pass composites one window — a range export — so it holds what that
 * window's pieces need and lets go of it when it ends. The pictures were
 * encoded for the delivery and join without a re-encode; the raw mixes and
 * stems lay end to end sample for sample, then are mastered, packed and
 * encoded once over the whole, as a single pass would.
 */
async function renderInPasses(
  job: RenderHandle,
  given: ExportSpec,
  windows: ExportRange[],
  mediaPathFor: (file: string) => string,
  io: ExportPipelineIO
) {
  // Colors are read once for every pass to share.
  given = await withSpecColors(given, mediaPathFor);
  const span = deliverySpan(given.range, given.duration);
  const ext = containerExtension(given);
  const stemPlan = given.stemPlan ?? [];
  const pieces = windows.map((w, k) => ({
    window: w,
    video: path.join(job.tmpDir, `piece_${k}${ext}`),
    mix: path.join(job.tmpDir, `piece_${k}.f32`),
    stems: stemPlan.map((_, i) => path.join(job.tmpDir, `piece_${k}_stem_${i}.wav`)),
  }));

  // The passes, in order; each takes its window's share of the progress.
  let done = 0;
  for (const p of pieces) {
    const seconds = p.window.end - p.window.start;
    const progress: [number, number] = [done / span, (done + seconds) / span];
    await renderPass(job, { ...given, range: p.window }, mediaPathFor, io, { kind: "piece", ...p, progress });
    stopIfCanceled(job);
    done += seconds;
  }

  // The mix: the pieces' raw samples read as one stream, mastered straight
  // off the pieces when the delivery asks for it.
  const mixRate = given.audioSampleRate ?? MIX_RATE;
  const mixChannels = given.audioChannels ?? 2;
  const raw = ["-f", "f32le", "-ar", String(mixRate), "-ac", String(mixChannels)];
  let mix = `concat:${pieces.map((p) => p.mix).join("|")}`;
  if (given.loudness !== undefined) {
    if (given.truePeakCeiling === undefined) {
      throw new Error("A mastered export needs its true-peak ceiling.");
    }
    const masteredPath = path.join(job.tmpDir, "master.f32");
    await io.masterRawMix(pieces.map((p) => p.mix), masteredPath, {
      sampleRate: mixRate,
      channels: mixChannels,
      targetLufs: given.loudness,
      ceilingDbtp: given.truePeakCeiling,
    });
    stopIfCanceled(job);
    mix = masteredPath;
  }

  // Each stem: its pieces joined into one file, then the pack.
  if (stemPlan.length > 0) {
    if (!job.stemsPath) {
      throw new Error("This export has nowhere to put its stems.");
    }
    const stemFiles = stemPlan.map((s, i) => ({ path: path.join(job.tmpDir, `stem_${i}.wav`), name: s.file }));
    for (const [i, stem] of stemFiles.entries()) {
      const list = path.join(job.tmpDir, `stem_${i}.ffconcat`);
      await io.writeFile(list, pieceList(pieces.map((p) => ({ file: p.stems[i], seconds: p.window.end - p.window.start }))));
      await io.runFfmpeg(job, ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", stem.path]);
    }
    await io.packStems(stemFiles, job.stemsPath);
    stopIfCanceled(job);
  }

  // The delivery: the pictures joined as encoded, the stray rotation flag
  // stripped as a single pass strips it, and the mix encoded under them.
  const list = path.join(job.tmpDir, "pieces.ffconcat");
  await io.writeFile(list, pieceList(pieces.map((p) => ({ file: p.video, seconds: p.window.end - p.window.start }))));
  await io.runFfmpeg(job, [
    "-y",
    "-display_rotation", "0",
    "-f", "concat", "-safe", "0", "-i", list,
    ...raw, "-i", mix,
    "-map", "0:v", "-map", "1:a",
    "-c:v", "copy", ...audioCodecArgs(given),
    "-t", num(span),
    "-movflags", "+faststart",
    job.outPath,
  ]);

  job.progress = 1;
}
