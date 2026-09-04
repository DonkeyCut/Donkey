/**
 * A stretch of a source played backward, laid on disk for the graph.
 *
 * ffmpeg turns a stream around by holding every frame of it, so one pass over
 * a long span would hold the whole span decoded at once — a minute of 4K is
 * gigabytes. The span is baked in chunks, from its end back to its start, each
 * turned on its own and encoded; the pieces are then joined stream-copy in
 * that order. The file plays the span backward, and the decoded picture held
 * at any moment is one chunk's worth, which is sized in bytes off the source's
 * frame size and rate. Source second `s` of the span sits at `pivot − s` in
 * the file, where `pivot` is what the bake reports back.
 *
 * A clip that plays backward is rendered off this file as a forward clip
 * (see `mirrorRetimable`), so the graph itself never turns anything around.
 */

import { num } from "./util";

/** The longest stretch of source one chunk turns at once, and the shortest.
 * The ceiling keeps the join list short on ordinary footage; the floor stops
 * a very heavy source from being cut into pieces too small to encode well. */
export const TURN_CHUNK_S = 3;
const TURN_CHUNK_MIN_S = 0.2;
/** Decoded picture one `reverse` pass may hold. ffmpeg keeps every frame of
 * the chunk in memory until the chunk ends, so this is the bake's real
 * ceiling: at 4K30 it comes to about a second of source, at 4K60 half of one. */
const TURN_HOLD_BYTES = 384 * 1024 * 1024;

/** Seconds of source a chunk may cover, given what a second of the source's
 * picture comes to decoded. */
export function turnChunkSeconds(decodeCost = 0): number {
  if (!(decodeCost > 0)) return TURN_CHUNK_S;
  return Math.max(TURN_CHUNK_MIN_S, Math.min(TURN_CHUNK_S, TURN_HOLD_BYTES / decodeCost));
}

/** The intermediate's H.264 quality, on the CRF scale; near-transparent, since
 * the graph encodes it once more. */
const TURN_CRF = 14;

export interface TurnIO {
  ffmpeg: (args: string[]) => Promise<void>;
  writeFile: (path: string, data: string) => Promise<void>;
  h264Encoder: () => Promise<"libx264" | "h264_videotoolbox">;
  /** How long a file runs; the bake reads the joined file back to learn what
   * it actually got. */
  duration: (path: string) => Promise<number | null>;
}

export interface TurnSpec {
  /** Absolute source seconds, `lo < hi`. */
  lo: number;
  hi: number;
  /** Which streams the source carries; the file carries the same. */
  video: boolean;
  audio: boolean;
  /** The picture's fold to BT.709 (see `sdrConvert`), run before the turn so
   * the file is plain SDR the graph converts nothing about. */
  colorFix: string;
  /** Bytes a second of the source's picture comes to decoded (see
   * `videoDecodeCost`), which sizes the chunks. */
  decodeCost?: number;
}

const vtQuality = (crf: number) => Math.round(Math.max(35, Math.min(80, 100 - crf * 1.8)));

/**
 * Bake `src`'s `[lo, hi]` turned around into `outFile`: a `.mov` when the
 * source has a picture, a `.wav` when it is sound alone.
 *
 * Returns the pivot the file is read through — source second `s` sits at
 * `pivot − s`. A span reaching past where the source ends comes back short,
 * and the missing part is the end that plays first, so the pivot is measured
 * from what the bake produced. Taking `hi` on faith would slide the clip's
 * whole length by the shortfall.
 */
export async function bakeTurnedMedia(
  io: TurnIO,
  src: string,
  spec: TurnSpec,
  outFile: string
): Promise<number> {
  const span = Math.max(0.001, spec.hi - spec.lo);
  const chunk = spec.video ? turnChunkSeconds(spec.decodeCost) : TURN_CHUNK_S;
  const n = Math.max(1, Math.ceil(span / chunk));
  const pieces: string[] = [];
  const enc = spec.video ? await io.h264Encoder() : null;
  for (let i = 0; i < n; i++) {
    // Chunks run from the span's end back to its start, so the joined file
    // plays the span backward.
    const to = spec.hi - i * chunk;
    const from = Math.max(spec.lo, to - chunk);
    if (to - from <= 1e-4) break;
    const piece = `${outFile}.${i}${spec.video ? ".mov" : ".wav"}`;
    const args = ["-y", "-hide_banner", "-loglevel", "error", "-ss", num(from), "-t", num(to - from), "-i", src];
    if (spec.video) {
      args.push("-vf", `${spec.colorFix}reverse,format=yuv420p`);
      args.push(
        ...(enc === "libx264"
          ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", String(TURN_CRF)]
          : ["-c:v", "h264_videotoolbox", "-q:v", String(vtQuality(TURN_CRF)), "-allow_sw", "1"])
      );
    } else {
      args.push("-vn");
    }
    if (spec.audio) args.push("-af", "areverse", "-c:a", spec.video ? "pcm_s16le" : "pcm_f32le");
    else args.push("-an");
    args.push(piece);
    await io.ffmpeg(args);
    pieces.push(piece);
  }
  const list = `${outFile}.txt`;
  await io.writeFile(list, pieces.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  await io.ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", outFile]);
  const made = await io.duration(outFile);
  if (made == null) throw new Error(`could not read back the turned file for ${src}`);
  return spec.lo + made;
}
