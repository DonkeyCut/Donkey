import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { hasVp9Encoder, runFfmpeg, videoEncoder, vtQuality, type RenderHandle } from "./exportPipeline";
import { assertGraphSafe } from "./filterGraph";
import { streamCodecs } from "./convert";
import { videoDimensions } from "./util";
import type { CompatCover } from "../lib/proxyNames";

/**
 * The preview proxy of a ProRes master, or of a heavy video a cloud project
 * streams: a 10-bit HEVC file the browser's hardware decoder plays at speed,
 * kept beside the master in the project's media. The master stays what an
 * export reads.
 *
 * The proxy carries the master's code values through the Rec.709 matrix: the
 * picture is taken out of the master's own matrix (BT.2020 non-constant on an
 * iPhone Apple Log file) into RGB at 16 bits and put back through Rec.709,
 * limited range, and the file is tagged Rec.709 / sRGB / Rec.709 all the way
 * down. Every decoder then draws the proxy's frames untouched — no tone
 * mapping, no gamut conversion — and the grade pipeline reads what the values
 * mean from the asset's `color`, which is still the master's. Timestamps are
 * copied, so frame N of the proxy sits where frame N of the master sits.
 *
 * The engine encodes with VideoToolbox, the worker with x265; both run the
 * argument list `proxyFfmpegArgs` builds.
 */

/** The proxy's file name beside its master: same stem, `.proxy.mp4`. */
export const proxyNameFor = (fileName: string) =>
  `${fileName.replace(/\.[^./\\]+$/, "") || "media"}.proxy.mp4`;

export type ProxyMatrix = "bt709" | "bt601" | "bt2020nc";

/** What the proxy is built from: the master's matrix and range, its height,
 * and whether it carries sound. */
export interface ProxySource {
  matrix: ProxyMatrix;
  fullRange: boolean;
  height: number;
  hasAudio: boolean;
}

export type ProxyEncoder = "hevc_videotoolbox" | "libx265";

export interface ProxyArgs {
  encoder: ProxyEncoder;
  source: ProxySource;
  /** The proxy's largest height; a taller master is scaled down. */
  maxHeight: number;
  /** x265 crf; VideoToolbox's constant quality maps from it. */
  crf: number;
  /** A light proxy's bitrate ceiling, kbit/s (lib/proxyNames.ts): x265 holds
   * it under its crf, VideoToolbox encodes at it. Absent = quality alone. */
  maxKbps?: number;
}

/** swscale's name for a matrix. */
const SWS_MATRIX: Record<ProxyMatrix, string> = { bt709: "bt709", bt601: "bt601", bt2020nc: "bt2020" };

/** ffmpeg's color_space name for what ffprobe reports. Untagged is Rec.709,
 * the reading every NLE gives an untagged file. */
export function proxyMatrixOf(colorSpace: string | undefined): ProxyMatrix {
  if (colorSpace === "bt2020nc" || colorSpace === "bt2020c") return "bt2020nc";
  if (colorSpace === "smpte170m" || colorSpace === "bt470bg" || colorSpace === "bt601") return "bt601";
  return "bt709";
}

/** The ffmpeg argument list for one proxy. */
export function proxyFfmpegArgs(src: string, out: string, opts: ProxyArgs): string[] {
  const { source, encoder } = opts;
  const cap = Math.max(2, Math.round(opts.maxHeight));
  const shrink = source.height > cap;
  // Even dimensions: 4:2:0 has no odd sizes.
  const size = shrink ? `:w=-2:h=${cap - (cap % 2)}` : "";
  const graph = [
    `scale=in_color_matrix=${SWS_MATRIX[source.matrix]}:in_range=${source.fullRange ? "pc" : "tv"}:out_range=pc${size}`,
    "format=gbrp16le",
    "scale=out_color_matrix=bt709:out_range=tv",
    `format=${encoder === "libx265" ? "yuv420p10le" : "p010le"}`,
    // The frames carry the tags the encoder writes into its own headers;
    // the stream options below cover the container.
    "setparams=color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709:range=tv",
  ].join(",");
  const kbps = opts.maxKbps && opts.maxKbps > 0 ? Math.round(opts.maxKbps) : 0;
  const video =
    encoder === "libx265"
      ? [
          "-c:v", "libx265", "-preset", "medium", "-crf", String(opts.crf),
          // A one-second buffer: the ceiling holds over every stretch the
          // preview fetches between keyframes.
          ...(kbps ? ["-maxrate", `${kbps}k`, "-bufsize", `${kbps}k`] : []),
          "-profile:v", "main10", "-x265-params", "log-level=error",
        ]
      : [
          "-c:v", "hevc_videotoolbox", "-profile:v", "main10",
          ...(kbps ? ["-b:v", `${kbps}k`] : ["-q:v", String(vtQuality(opts.crf))]),
          "-allow_sw", "1",
        ];
  return [
    "-y",
    // The master's timestamps, unshifted: the preview maps clip time to
    // proxy time exactly as it maps it to master time.
    "-copyts",
    "-i", src,
    "-map", "0:v:0",
    ...(source.hasAudio ? ["-map", "0:a:0"] : []),
    "-vf", assertGraphSafe(graph),
    "-color_primaries", "bt709",
    "-color_trc", "iec61966-2-1",
    "-colorspace", "bt709",
    "-color_range", "tv",
    ...video,
    // A keyframe every second of the master's time: the preview seeks into
    // the proxy at every cut, and a seek decodes from the keyframe before it.
    // Counted from the last forced one, since -copyts keeps a master's own
    // start time (a transport stream can start at 1000 s).
    "-force_key_frames", "expr:if(isnan(prev_forced_t),1,gte(t,prev_forced_t+1))",
    "-tag:v", "hvc1",
    ...(source.hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : []),
    "-movflags", "+faststart",
    out,
  ];
}

/** Read what the proxy is built from off the master's header. */
export function probeProxySource(file: string): Promise<ProxySource> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "stream=codec_type,color_space,color_range,height:stream_side_data=rotation",
      "-of", "json",
      file,
    ]);
    let out = "";
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error("Media inspection timed out."));
    }, 30_000);
    timer.unref();
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error("Could not inspect this media file."));
      try {
        const streams = (JSON.parse(out).streams ?? []) as {
          codec_type?: string;
          color_space?: string;
          color_range?: string;
          height?: number;
          width?: number;
          side_data_list?: { rotation?: number }[];
        }[];
        const video = streams.find((s) => s.codec_type === "video");
        if (!video) return reject(new Error("That file carries no video."));
        resolve({
          matrix: proxyMatrixOf(video.color_space),
          fullRange: video.color_range === "pc",
          height: Number(video.height) || 0,
          hasAudio: streams.some((s) => s.codec_type === "audio"),
        });
      } catch (error) {
        reject(error);
      }
    });
    p.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** The HEVC encoder this machine's ffmpeg carries: x265 in the worker's
 * build, VideoToolbox on the Mac's. */
export async function proxyEncoder(): Promise<ProxyEncoder> {
  return (await videoEncoder("hevc")) === "libx265" ? "libx265" : "hevc_videotoolbox";
}

export interface ProxyOutcome {
  sizeBytes: number;
  width?: number;
  height?: number;
}

/** Build the proxy of `src` at `out`. */
export async function makeProxy(
  handle: RenderHandle,
  src: string,
  out: string,
  opts: { maxHeight: number; crf: number; maxKbps?: number; onProgress?: (seconds: number) => void }
): Promise<ProxyOutcome> {
  const [source, dims, encoder] = await Promise.all([probeProxySource(src), videoDimensions(src), proxyEncoder()]);
  // The display height decides the scale — a phone's sideways file is
  // measured upright everywhere else in Cut.
  if (dims) source.height = dims.height;
  await runFfmpeg(handle, proxyFfmpegArgs(src, out, { encoder, source, maxHeight: opts.maxHeight, crf: opts.crf, maxKbps: opts.maxKbps }), opts.onProgress);
  const [info, outDims] = await Promise.all([stat(out), videoDimensions(out)]);
  return { sizeBytes: info.size, ...(outDims ? { width: outDims.width, height: outDims.height } : {}) };
}

/** VP9's crf on its own 0–63 scale, from the x265 crf every proxy is
 * configured with: 20 maps to 32. */
export function vp9Crf(crf: number) {
  return Math.round(Math.max(15, Math.min(50, crf * 1.6)));
}

/** The compat proxy's sound: Opus, which every browser decodes. */
const OPUS_KBPS = 128;

/** Picture codecs an MP4 holds as they are, so a sound-only cover can copy
 * them. Anything else (ProRes, DNxHD) is encoded to H.264. */
const MP4_PICTURES = new Set(["h264", "hevc", "av1", "vp9", "mpeg4"]);

/** A keyframe every second of the master's time, counted from the last
 * forced one, as the HEVC proxy places them. */
const KEY_EVERY_SECOND = "expr:if(isnan(prev_forced_t),1,gte(t,prev_forced_t+1))";

export interface CompatArgs {
  cover: CompatCover;
  /** The proxy's largest height; a taller master is scaled down. */
  maxHeight: number;
  /** x265 crf, mapped to VP9's scale or handed to x264. */
  crf: number;
  /** A light proxy's bitrate ceiling, kbit/s. */
  maxKbps?: number;
}

/** The ffmpeg argument list for one compat proxy (lib/proxyNames.ts). Its
 * picture keeps the proxy contract: Rec.709 limited code values on the
 * master's timestamps, so every reader treats it as any proxy. `source` is
 * null for a file with no picture; `h264` names this machine's encoder. */
export function compatFfmpegArgs(
  src: string,
  out: string,
  opts: CompatArgs & { source: ProxySource | null; videoCodec: string | null; hasAudio: boolean; h264: string }
): string[] {
  const { source } = opts;
  const cap = Math.max(2, Math.round(opts.maxHeight));
  const kbps = opts.maxKbps && opts.maxKbps > 0 ? Math.round(opts.maxKbps) : 0;
  const video: string[] = [];
  if (!source) {
    video.push("-vn");
  } else {
    video.push("-map", "0:v:0");
    // A sound-only cover keeps the master's size unless it is a light one.
    const shrink = source.height > cap && (opts.cover === "video" || !!kbps);
    // A Rec.709 limited picture already is what a proxy holds, so a
    // sound-only cover copies it packet for packet when the MP4 can hold it.
    const copy =
      opts.cover === "audio" && source.matrix === "bt709" && !source.fullRange && !shrink && !kbps &&
      MP4_PICTURES.has(opts.videoCodec ?? "");
    if (copy) {
      video.push("-c:v", "copy");
    } else {
      const size = shrink ? `:w=-2:h=${cap - (cap % 2)}` : "";
      const graph = [
        `scale=in_color_matrix=${SWS_MATRIX[source.matrix]}:in_range=${source.fullRange ? "pc" : "tv"}:out_range=pc${size}`,
        "format=gbrp16le",
        "scale=out_color_matrix=bt709:out_range=tv",
        "format=yuv420p",
        "setparams=color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709:range=tv",
      ].join(",");
      video.push("-vf", assertGraphSafe(graph), "-color_primaries", "bt709", "-color_trc", "iec61966-2-1", "-colorspace", "bt709", "-color_range", "tv");
      if (opts.cover === "video") {
        video.push(
          "-c:v", "libvpx-vp9", "-crf", String(vp9Crf(opts.crf)), "-b:v", kbps ? `${kbps}k` : "0",
          "-deadline", "good", "-cpu-used", "4", "-row-mt", "1"
        );
      } else if (opts.h264 === "libx264") {
        video.push("-c:v", "libx264", "-preset", "medium", "-crf", String(opts.crf), ...(kbps ? ["-maxrate", `${kbps}k`, "-bufsize", `${kbps}k`] : []));
      } else {
        video.push("-c:v", "h264_videotoolbox", ...(kbps ? ["-b:v", `${kbps}k`] : ["-q:v", String(vtQuality(opts.crf))]), "-allow_sw", "1");
      }
      video.push("-force_key_frames", KEY_EVERY_SECOND);
    }
  }
  const audio = opts.hasAudio ? ["-map", "0:a:0", "-c:a", "libopus", "-b:a", `${OPUS_KBPS}k`] : ["-an"];
  return [
    "-y",
    "-copyts",
    "-i", src,
    ...video,
    ...audio,
    ...(opts.cover === "video" ? [] : ["-movflags", "+faststart"]),
    out,
  ];
}

/** Build the compat proxy of `src` at `out`: VP9 and Opus in WebM, or the
 * master's picture with Opus sound in MP4 (lib/proxyNames.ts). */
export async function makeCompatProxy(
  handle: RenderHandle,
  src: string,
  out: string,
  opts: CompatArgs & { onProgress?: (seconds: number) => void }
): Promise<ProxyOutcome> {
  const codecs = await streamCodecs(src);
  if (opts.cover === "video" && !codecs.video) throw new Error("That file carries no video.");
  if (opts.cover === "video" && !(await hasVp9Encoder())) throw new Error("This machine's ffmpeg has no VP9 encoder.");
  const [source, dims, h264] = await Promise.all([
    codecs.video ? probeProxySource(src) : Promise.resolve(null),
    codecs.video ? videoDimensions(src) : Promise.resolve(null),
    videoEncoder("h264"),
  ]);
  if (source && dims) source.height = dims.height;
  await runFfmpeg(handle, compatFfmpegArgs(src, out, { ...opts, source, videoCodec: codecs.video ?? null, hasAudio: !!codecs.audio, h264 }), opts.onProgress);
  const [info, outDims] = await Promise.all([stat(out), source ? videoDimensions(out) : Promise.resolve(null)]);
  return { sizeBytes: info.size, ...(outDims ? { width: outDims.width, height: outDims.height } : {}) };
}
