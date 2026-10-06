/**
 * A recording laid on its video's clock, for the ffmpeg graphs.
 *
 * A video bound to a separately recorded sound (`soundFrom`) plays the
 * recording `offset` seconds past its own source time. The graphs read a
 * clip's sound through the clip's own trim and retime map, so the recording
 * is first written out over the stretch of video source seconds the clip can
 * reach, starting at that stretch's first second: second `τ` of the file is
 * video second `lo + τ`. Where the recording had not started yet, or had
 * already stopped, the file holds silence, so every read stays on time. The
 * clip then sounds from this file like any other, through the same map.
 */

import { BAKE_RATE } from "./retimeAudio";

/** Six decimals: a seek and a length to the microsecond, well under a sample. */
const exact = (n: number) => n.toFixed(6);

/**
 * Write video source seconds `[lo, hi]` of the recording `rec` (bound with
 * `offset`, `duration` seconds long) to `outFile`, a stereo float WAV at the
 * bake rate, silence-padded to the whole window. False when the recording
 * holds none of the window; nothing is written then.
 */
export async function alignRecording(
  ffmpeg: (args: string[]) => Promise<void>,
  rec: string,
  bound: { offset: number; duration: number },
  lo: number,
  hi: number,
  outFile: string,
  /** A mono recording is laid into both channels at full level, the way the
   * browser's mixer upmixes it. */
  opts: { mono?: boolean } = {}
): Promise<boolean> {
  const len = hi - lo;
  const start = lo + bound.offset;
  const from = Math.max(0, start);
  const to = Math.min(bound.duration, hi + bound.offset);
  if (!(len > 0.001) || !(to - from > 0.001)) return false;
  const pad = Math.round((from - start) * BAKE_RATE);
  await ffmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    exact(from),
    "-i",
    rec,
    "-t",
    exact(to - from),
    "-vn",
    "-af",
    `aresample=${BAKE_RATE},` +
      (opts.mono ? "pan=stereo|c0=c0|c1=c0," : "aformat=channel_layouts=stereo,") +
      (pad > 0 ? `adelay=delays=${pad}S:all=1,` : "") +
      `apad=whole_len=${Math.round(len * BAKE_RATE)}`,
    "-t",
    exact(len),
    "-ar",
    String(BAKE_RATE),
    "-c:a",
    "pcm_f32le",
    outFile,
  ]);
  return true;
}
