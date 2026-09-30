import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { runFfmpeg, videoEncoder, vtQuality, type RenderHandle } from "./exportPipeline";
import { assertGraphSafe } from "./filterGraph";
import { videoDimensions } from "./util";

/**
 * The preview proxy of a ProRes master: a 10-bit HEVC file the browser's
 * hardware decoder plays at speed, kept beside the master in the project's
 * media. The master stays what an export reads.
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
  const video =
    encoder === "libx265"
      ? ["-c:v", "libx265", "-preset", "medium", "-crf", String(opts.crf), "-profile:v", "main10", "-x265-params", "log-level=error"]
      : ["-c:v", "hevc_videotoolbox", "-profile:v", "main10", "-q:v", String(vtQuality(opts.crf)), "-allow_sw", "1"];
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
  opts: { maxHeight: number; crf: number; onProgress?: (seconds: number) => void }
): Promise<ProxyOutcome> {
  const [source, dims, encoder] = await Promise.all([probeProxySource(src), videoDimensions(src), proxyEncoder()]);
  // The display height decides the scale — a phone's sideways file is
  // measured upright everywhere else in Cut.
  if (dims) source.height = dims.height;
  await runFfmpeg(handle, proxyFfmpegArgs(src, out, { encoder, source, maxHeight: opts.maxHeight, crf: opts.crf }), opts.onProgress);
  const [info, outDims] = await Promise.all([stat(out), videoDimensions(out)]);
  return { sizeBytes: info.size, ...(outDims ? { width: outDims.width, height: outDims.height } : {}) };
}
