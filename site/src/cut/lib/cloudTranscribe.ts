"use client";

// Browser-side audio work for a project whose media the engine doesn't hold,
// and the hosted transcriber that goes with it. Rendering the mix is shared:
// an OfflineAudioContext applies the same trims, speeds, volumes, and
// crossfades the engine's ffmpeg graph does (see server/transcribe.ts), so the
// result is the cut's audible mix in timeline time — whether it then goes to
// this Mac (localStt.ts) or to the hosted route, which includes each
// account's first chunks and meters the rest. The hosted path
// chunks it as 16 kHz mono WAV, POSTs each chunk, stitches the cues back into
// timeline time, and interpolates per-word timings. Mic dictation reuses the
// same chunk/post/stitch core on a MediaRecorder capture.

import { renderMix as mixAudio } from "./audioMix";
import { apiFetch } from "./backend";
import { mediaUrl, type SubtitleCue } from "./types";

/** Mirror of the engine's TranscribeSpec (server/transcribe.ts) minus projectId. */
export interface CloudTranscribeSpec {
  duration: number;
  locale?: string;
  clips: {
    file: string;
    in: number;
    out: number;
    muted: boolean;
    speed?: number;
    speedCurve?: [number, number][];
    /** Cross-dissolve overlap into the next clip, timeline seconds. */
    transition?: number;
  }[];
  audio: { file: string; in: number; out: number; start: number; volume: number; speed?: number; speedCurve?: [number, number][] }[];
}

const RATE = 16000; // the wire format the hosted route expects
// The hosted model reads times off the audio by ear, and its clock drifts as a
// chunk runs on — cues open in sync and land seconds late by the end of a long
// one. Every chunk boundary re-anchors that clock at a known offset, so the
// chunk length is what bounds the drift: short enough to keep it inside the
// alignment pass's snap window, long enough that a sentence keeps its context.
const CHUNK_SECONDS = 20;
const OVERLAP_SECONDS = 3; // audio shared across chunk seams for stitching
const POSTS_IN_FLIGHT = 4; // short chunks mean more round-trips; overlap them
// A chunk quieter than this end to end carries no speech; skip the round-trip
// (and its credit charge) — the engine path short-circuits silence the same way.
const SILENCE_PEAK = 1e-3;

const uid = () => crypto.randomUUID().slice(0, 8);
const round = (n: number) => Math.round(n * 1000) / 1000;

/** Render the cut's audible mix to a 16 kHz mono buffer — the wire format the
 * speech models read. The fold itself is the shared one (audioMix.ts), so the
 * audio a caption is timed against is the same audio an export writes, at a
 * different rate. Returns null when nothing audible exists. */
export function renderMix(
  projectId: string,
  spec: CloudTranscribeSpec
): Promise<AudioBuffer | null> {
  return mixAudio(
    {
      duration: spec.duration,
      clips: spec.clips,
      // Transcription hears the soundtrack the way the viewer will, minus the
      // shaping it does not change the timing of.
      items: spec.audio,
    },
    { sampleRate: RATE, channels: 1, resolve: (file) => mediaUrl(projectId, file) }
  );
}

/** 16-bit PCM WAV (RIFF) from mono 16 kHz float samples. */
export function encodeWav(samples: Float32Array): Blob {
  const data = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) data.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  data.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true); // PCM
  data.setUint16(22, 1, true); // mono
  data.setUint32(24, RATE, true);
  data.setUint32(28, RATE * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  ascii(36, "data");
  data.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([data.buffer], { type: "audio/wav" });
}

function isSilent(samples: Float32Array): boolean {
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) > SILENCE_PEAK) return false;
  }
  return true;
}

interface WireCue {
  start: number;
  end: number;
  text: string;
}

// The route's error code for an account whose included chunks are used up.
// A `freeOnly` caller reads it off the thrown error and stops transcribing.
const FREE_EXHAUSTED_CODE = "free_transcription_exhausted";

export class HostedTranscribeError extends Error {
  public constructor(
    message: string,
    public readonly code?: string
  ) {
    super(message);
    this.name = "HostedTranscribeError";
  }
}

export const isFreeTranscriptionExhausted = (e: unknown): boolean =>
  e instanceof HostedTranscribeError && e.code === FREE_EXHAUSTED_CODE;

async function postChunk(
  samples: Float32Array,
  offset: number,
  locale: string | undefined,
  freeOnly: boolean
): Promise<WireCue[]> {
  const form = new FormData();
  form.append("audio", new File([encodeWav(samples)], "chunk.wav", { type: "audio/wav" }));
  form.append("offset", String(round(offset)));
  if (locale) form.append("locale", locale);
  if (freeOnly) form.append("freeOnly", "1");
  const res = await apiFetch("/api/cut/transcribe", { method: "POST", body: form });
  const body = (await res.json().catch(() => null)) as
    | { cues?: WireCue[]; error?: string; message?: string }
    | null;
  if (!res.ok) {
    throw new HostedTranscribeError(
      body?.message ?? body?.error ?? "Transcription failed.",
      body?.error
    );
  }
  return (body?.cues ?? []).filter(
    (c) =>
      typeof c?.start === "number" &&
      typeof c?.end === "number" &&
      typeof c?.text === "string" &&
      Number.isFinite(c.start) &&
      Number.isFinite(c.end)
  );
}

/** Proportional word timings inside a cue: split the text into words and
 * distribute [start, end] by each word's share of the characters. */
function interpolateWords(
  text: string,
  start: number,
  end: number
): { t0: number; t1: number; w: string }[] {
  const parts = text.split(/\s+/).filter(Boolean);
  const total = parts.reduce((n, w) => n + w.length, 0) || 1;
  const span = Math.max(0, end - start);
  let at = start;
  return parts.map((w) => {
    const d = (w.length / total) * span;
    const word = { t0: round(at), t1: round(at + d), w };
    at += d;
    return word;
  });
}

/** Chunk mono 16 kHz samples, transcribe each chunk, and stitch: cue times
 * re-base by chunk offset, and in each 3s overlap the midpoint of the seam
 * decides ownership — cues whose center falls in the earlier chunk's half are
 * dropped from the later one (and vice versa), so seams never duplicate.
 * Returns null when `isStale` trips mid-run. */
export async function transcribeSamples(
  samples: Float32Array,
  locale: string | undefined,
  isStale?: () => boolean,
  opts?: { freeOnly?: boolean }
): Promise<SubtitleCue[] | null> {
  const duration = samples.length / RATE;
  const step = (CHUNK_SECONDS - OVERLAP_SECONDS) * RATE;
  const chunks: { slice: Float32Array; offset: number; last: boolean }[] = [];
  for (let s = 0; s < samples.length; s += step) {
    const slice = samples.subarray(s, Math.min(samples.length, s + CHUNK_SECONDS * RATE));
    const last = s + CHUNK_SECONDS * RATE >= samples.length;
    if (!isSilent(slice)) chunks.push({ slice, offset: s / RATE, last });
    if (last) break;
  }

  // A small pool posts the chunks; a failure parks its error and drains the
  // pool so no further metered calls go out.
  const results: WireCue[][] = chunks.map(() => []);
  let next = 0;
  let failed: unknown;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= chunks.length || failed !== undefined || isStale?.()) return;
      try {
        results[i] = await postChunk(chunks[i].slice, chunks[i].offset, locale, opts?.freeOnly ?? false);
      } catch (error) {
        failed = error;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(POSTS_IN_FLIGHT, chunks.length) }, worker));
  if (isStale?.()) return null;
  if (failed !== undefined) throw failed;

  const cues: SubtitleCue[] = [];
  for (const [i, { slice, offset, last }] of chunks.entries()) {
    const from = i === 0 ? -Infinity : offset + OVERLAP_SECONDS / 2;
    const to = last ? Infinity : offset + slice.length / RATE - OVERLAP_SECONDS / 2;
    for (const c of results[i]) {
      const start = Math.max(0, Math.min(c.start + offset, duration));
      const end = Math.max(0, Math.min(c.end + offset, duration));
      const text = c.text.trim();
      const mid = (start + end) / 2;
      if (!text || end <= start || mid < from || mid >= to) continue;
      cues.push({
        id: uid(),
        start: round(start),
        end: round(end),
        text,
        words: interpolateWords(text, start, end),
      });
    }
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** Transcribe a finished mic recording: decode it, downmix/resample to the
 * wire format, run the chunk pipeline, and join the cue texts. */
export async function cloudTranscribeRecording(blob: Blob, locale?: string): Promise<string> {
  const bytes = await blob.arrayBuffer();
  // Decode at the device rate, then resample/downmix through an offline
  // render — decodeAudioData resamples to its context's rate, but the mono
  // 16 kHz target length isn't known until after the decode.
  const probe = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await probe.decodeAudioData(bytes);
  } catch {
    throw new Error("Could not read the recording's audio.");
  } finally {
    void probe.close().catch(() => {});
  }
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * RATE)), RATE);
  const src = ctx.createBufferSource();
  src.buffer = decoded;
  src.connect(ctx.destination);
  src.start();
  const mono = (await ctx.startRendering()).getChannelData(0);
  const cues = await transcribeSamples(mono, locale);
  return (cues ?? [])
    .map((c) => c.text)
    .join(" ")
    .trim();
}
