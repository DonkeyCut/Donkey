import { spawn } from "node:child_process";
import { h264Encoder, runFfmpeg, sdrConvert, vtQuality, type RenderHandle } from "./exportPipeline";
import { assertGraphSafe } from "./filterGraph";
import { videoColorInfo, videoDimensions } from "./util";

/**
 * Re-wrapping one media file as an MP4 every player and every browser opens.
 *
 * Two shapes come out of the same call. A file whose streams already fit —
 * H.264 picture, AAC sound — is remuxed: the packets are copied into the new
 * container untouched, which costs a read and a write and loses nothing. A
 * file whose picture is HEVC or ProRes, or whose sound is the raw PCM a phone
 * and a camera write into QuickTime, is re-encoded, one stream at a time, so
 * a .mov with H.264 picture and PCM sound only pays for its audio.
 *
 * The engine calls this on the Mac's own ffmpeg; the render worker calls it in
 * the container. Both hand it a `RenderHandle`, which is what carries a cancel
 * (killing the live process) and the rolling log an error message is cut from.
 */

/** Codecs the target container and the browsers Cut runs in both take. */
const KEEPS_VIDEO = new Set(["h264"]);
const KEEPS_AUDIO = new Set(["aac", "mp3"]);

/** The quality tier a conversion encodes at — visually transparent for
 * footage that is about to be edited, cut, and exported again. */
const CONVERT_CRF = 20;

export interface ConvertOutcome {
  /** True when the picture was re-encoded; false when its packets were copied. */
  transcodedVideo: boolean;
  transcodedAudio: boolean;
  /** The source was already the file this would produce, so nothing was
   * written and `out` does not exist. */
  unchanged?: boolean;
  width?: number;
  height?: number;
}

/** Containers that hold the target streams under the name people ask for. */
const MP4_EXT = /\.(mp4|m4v)$/i;

/** Whether a source is already what a conversion would produce, so the job is
 * to leave it alone. */
export const fitsAlready = (
  file: string,
  codecs: { video?: string; audio?: string },
  work: { shrink: boolean; sdr: boolean }
) =>
  MP4_EXT.test(file) &&
  !work.shrink &&
  !work.sdr &&
  (!codecs.video || KEEPS_VIDEO.has(codecs.video)) &&
  (!codecs.audio || KEEPS_AUDIO.has(codecs.audio));

/** The first video and audio stream's codec names, or undefined for a file
 * that carries no such stream (or a probe that fails — the conversion then
 * takes the re-encode path, which is correct for anything). */
export function streamCodecs(file: string): Promise<{ video?: string; audio?: string }> {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "stream=codec_type,codec_name",
      "-of", "json",
      file,
    ]);
    let out = "";
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      resolve({});
    }, 30_000);
    timer.unref();
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({});
      try {
        const streams = (JSON.parse(out).streams ?? []) as {
          codec_type?: string;
          codec_name?: string;
        }[];
        resolve({
          video: streams.find((s) => s.codec_type === "video")?.codec_name,
          audio: streams.find((s) => s.codec_type === "audio")?.codec_name,
        });
      } catch {
        resolve({});
      }
    });
    p.on("error", () => {
      clearTimeout(timer);
      resolve({});
    });
  });
}

/**
 * Convert `src` into an MP4 at `out`. `maxHeight` caps the picture's display
 * height — the height the rest of Cut measures, with the container's rotation
 * already applied — and forces a re-encode when the source is taller.
 */
export async function convertToMp4(
  handle: RenderHandle,
  src: string,
  out: string,
  opts: { maxHeight?: number; onProgress?: (seconds: number) => void } = {}
): Promise<ConvertOutcome> {
  const [codecs, dims] = await Promise.all([streamCodecs(src), videoDimensions(src)]);
  if (!codecs.video && !codecs.audio) throw new Error("That file carries no video or audio.");

  const cap = opts.maxHeight && opts.maxHeight > 0 ? Math.round(opts.maxHeight) : 0;
  const shrink = !!(cap && dims && dims.height > cap);
  const color = codecs.video ? await videoColorInfo(src) : null;
  const sdr = sdrConvert(color);
  const transcodedVideo = !!codecs.video && (!KEEPS_VIDEO.has(codecs.video) || shrink || !!sdr);
  const transcodedAudio = !!codecs.audio && !KEEPS_AUDIO.has(codecs.audio);
  if (fitsAlready(src, codecs, { shrink, sdr: !!sdr })) {
    return {
      transcodedVideo: false,
      transcodedAudio: false,
      unchanged: true,
      ...(dims ? { width: dims.width, height: dims.height } : {}),
    };
  }

  const video: string[] = [];
  if (codecs.video) {
    video.push("-map", "0:v:0");
    if (!transcodedVideo) {
      video.push("-c:v", "copy");
    } else {
      // Even dimensions: H.264 in 4:2:0 has no odd sizes, and the scale filter
      // is where an odd source height would otherwise land.
      const scale = shrink ? `scale=-2:${cap - (cap % 2)},` : "";
      const chain = `${sdr}${scale}`.replace(/,$/, "");
      if (chain) video.push("-vf", assertGraphSafe(chain));
      const enc = await h264Encoder();
      video.push(
        ...(enc === "libx264"
          ? ["-c:v", "libx264", "-preset", "medium", "-crf", String(CONVERT_CRF)]
          : ["-c:v", "h264_videotoolbox", "-q:v", String(vtQuality(CONVERT_CRF)), "-allow_sw", "1"]),
        "-pix_fmt", "yuv420p"
      );
    }
  }

  const audio: string[] = [];
  if (codecs.audio) {
    audio.push("-map", "0:a:0");
    audio.push(...(transcodedAudio ? ["-c:a", "aac", "-b:a", "192k"] : ["-c:a", "copy"]));
  }

  await runFfmpeg(
    handle,
    [
      "-y",
      "-i", src,
      ...video,
      ...audio,
      // The index rides at the head of the file, so streamed playback starts
      // on the first bytes — a clip previews while it is still uploading.
      "-movflags", "+faststart",
      out,
    ],
    opts.onProgress
  );

  const outDims = transcodedVideo ? await videoDimensions(out) : dims;
  return {
    transcodedVideo,
    transcodedAudio,
    ...(outDims ? { width: outDims.width, height: outDims.height } : {}),
  };
}

/** The MP4 name a source file converts to: same stem, `.mp4` extension. */
export const mp4NameFor = (fileName: string) =>
  `${fileName.replace(/\.[^./\\]+$/, "") || "media"}.mp4`;
