/**
 * The sound of a clip whose rate changes through its footage, laid for
 * ffmpeg.
 *
 * `atempo` takes one constant, and the bundled build (LGPL) carries nothing
 * that takes a schedule. So a curved clip's audio is baked ahead of the graph:
 * the trimmed span — widened by the handles a crossing reaches into — decodes
 * to float PCM through ffmpeg, the same WSOLA the preview and the in-tab export
 * run stretches it along the clip's own map, and the result lands as a WAV the
 * graph reads like any other input, in timeline seconds and needing no tempo.
 * One stretch implementation serves every renderer, which is the parity the
 * export path promises.
 */

import type { Retime } from "@donkeycut/effects-kit";
import { timeStretch } from "../lib/timeStretch";
import { num } from "./util";

/** The bake's sample rate: what the graphs resample every input to. */
export const BAKE_RATE = 44100;
const CHANNELS = 2;

export interface BakedAudio {
  /** The WAV on disk. */
  file: string;
  /** Timeline seconds the file holds before the clip's head (the back handle
   * it was baked with, clamped to the source's start). */
  back: number;
  /** Timeline seconds the file runs. */
  len: number;
}

export interface BakeIO {
  /** Run ffmpeg with these args to completion. */
  ffmpeg: (args: string[]) => Promise<void>;
  readFile: (path: string) => Promise<Uint8Array>;
  writeFile: (path: string, data: Uint8Array) => Promise<void>;
  /** Drop the intermediate PCM once it is read. */
  unlink: (path: string) => Promise<void>;
}

/**
 * Bake `src`'s sound over the clip's span, plus `back` timeline seconds
 * before its head and `ahead` after its tail, into `outFile`.
 */
export async function bakeRetimedAudio(
  io: BakeIO,
  src: string,
  retime: Retime,
  back: number,
  ahead: number,
  outFile: string
): Promise<BakedAudio> {
  const rt = retime;
  // A handle cannot reach before the source's first sample; the head reach
  // is whatever the source really had.
  const from = Math.max(0, rt.srcAt(-Math.max(0, back)));
  const to = Math.max(from, rt.srcAt(rt.len + Math.max(0, ahead)));
  const pcm = `${outFile}.f32`;
  await io.ffmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    num(from),
    "-i",
    src,
    "-t",
    num(Math.max(0.001, to - from)),
    "-vn",
    "-ac",
    String(CHANNELS),
    "-ar",
    String(BAKE_RATE),
    "-f",
    "f32le",
    pcm,
  ]);
  let raw: Uint8Array | null = await io.readFile(pcm);
  await io.unlink(pcm).catch(() => {});
  // A DataView reads the samples wherever the buffer starts, so the span is
  // held once rather than copied to an aligned array first — this is minutes
  // of audio on a long clip.
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const frames = Math.floor(raw.byteLength / 4 / CHANNELS);
  const channels = Array.from({ length: CHANNELS }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < CHANNELS; c++)
      channels[c][i] = view.getFloat32((i * CHANNELS + c) * 4, true);
  // The read buffer is dead once the channels hold the samples; letting go of
  // it here keeps the stretch from running beside a second copy of the span.
  raw = null;
  // The file may run short of `to` — the source ended first — so the output
  // length follows the samples actually read, through the same map.
  const inSec = frames / BAKE_RATE;
  const tFrom = rt.tAt(from);
  const outLength = Math.max(1, Math.round((rt.tAt(from + inSec) - tFrom) * BAKE_RATE));
  const out = timeStretch(channels, BAKE_RATE, {
    factorAt: (sec) => 1 / rt.rateAtSrc(from + sec),
    outLength,
  });
  await io.writeFile(outFile, wavFloat32(out, BAKE_RATE));
  return { file: outFile, back: -tFrom, len: outLength / BAKE_RATE };
}

/** A WAV container around float samples: what ffmpeg reads back as pcm_f32le. */
export function wavFloat32(channels: Float32Array[], sampleRate: number): Uint8Array {
  const n = channels[0]?.length ?? 0;
  const ch = Math.max(1, channels.length);
  const dataBytes = n * ch * 4;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // IEEE float
  view.setUint16(22, ch, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * ch * 4, true);
  view.setUint16(32, ch * 4, true);
  view.setUint16(34, 32, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  const samples = new Float32Array(buf, 44, n * ch);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < ch; c++) samples[i * ch + c] = channels[c]?.[i] ?? 0;
  return new Uint8Array(buf);
}

/**
 * The `setpts` expression that lays a clip's frames along its map: the
 * reduced polyline of the retime as a sum of clipped ramps, so nothing nests
 * however many knots the curve has. `T - STARTT` is the frame's seconds past
 * the trim's first frame; the sum is its timeline second, over the timebase.
 */
export function setptsExpr(retime: Retime): string {
  // Slopes carry six places: a rounded slope drifts by its error times the
  // knot's width, and three places would put a long ramp a frame off.
  const fnum = (n: number) => String(Math.round(n * 1e6) / 1e6);
  const k = retime.knots;
  const terms: string[] = [];
  for (let i = 0; i + 1 < k.length; i++) {
    const [s0, t0] = k[i];
    const [s1, t1] = k[i + 1];
    const w = s1 - s0;
    if (w <= 0) continue;
    const slope = (t1 - t0) / w;
    const x = i === 0 ? "T-STARTT" : `T-STARTT-${fnum(s0)}`;
    terms.push(`clip(${x},0,${fnum(w)})*${fnum(slope)}`);
  }
  if (terms.length === 0) return "PTS-STARTPTS";
  return `(${terms.join("+")})/TB`;
}
