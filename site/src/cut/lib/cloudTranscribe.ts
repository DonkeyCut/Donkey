"use client";

// Browser-side audio work for a project whose media the engine doesn't hold,
// and the hosted transcriber that goes with it. Rendering the mix is shared:
// an OfflineAudioContext applies the same trims, speeds, volumes, and
// crossfades the engine's ffmpeg graph does (see server/transcribe.ts), so the
// result is the cut's audible mix in timeline time — whether it then goes to
// this Mac (localStt.ts) or to the metered hosted route. The hosted path
// chunks it as 16 kHz mono WAV, POSTs each chunk, stitches the cues back into
// timeline time, and interpolates per-word timings. Mic dictation reuses the
// same chunk/post/stitch core on a MediaRecorder capture.

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
    /** Cross-dissolve overlap into the next clip, timeline seconds. */
    transition?: number;
  }[];
  audio: { file: string; in: number; out: number; start: number; volume: number; speed?: number }[];
}

const RATE = 16000; // the wire format the hosted route expects
const CHUNK_SECONDS = 90; // ~2.9MB of 16-bit mono PCM per chunk
const OVERLAP_SECONDS = 3; // audio shared across chunk seams for stitching
// A chunk quieter than this end to end carries no speech; skip the round-trip
// (and its credit charge) — the engine path short-circuits silence the same way.
const SILENCE_PEAK = 1e-3;

const uid = () => crypto.randomUUID().slice(0, 8);
const round = (n: number) => Math.round(n * 1000) / 1000;
const speedOf = (s?: number) => (s && s > 0 ? s : 1);

/** Timeline length of one spec clip: source span over speed. A gap spacer
 * (no file) keeps its exact length — flooring it would land later cues late. */
const clipDur = (c: CloudTranscribeSpec["clips"][number]) =>
  c.file ? Math.max(0.1, (c.out - c.in) / speedOf(c.speed)) : Math.max(0, c.out - c.in);

/** Render the cut's audible mix to a 16 kHz mono buffer, mirroring the engine's
 * ffmpeg graph: clip audio folds sequentially with cross-dissolves overlapping
 * (linear crossfade ≈ acrossfade's tri curve), soundtrack/voiceover items land
 * at their absolute starts with their volumes, and speed rides playbackRate
 * (pitch shifts where atempo would preserve it — timing, which is what cue
 * placement needs, is identical). Returns null when nothing audible exists. */
export async function renderMix(
  projectId: string,
  spec: CloudTranscribeSpec
): Promise<AudioBuffer | null> {
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(spec.duration * RATE)), RATE);
  const files = [...new Set([...spec.clips, ...spec.audio].map((c) => c.file).filter(Boolean))];
  const buffers = new Map<string, AudioBuffer>();
  await Promise.all(
    files.map(async (f) => {
      try {
        const res = await fetch(mediaUrl(projectId, f));
        if (!res.ok) return;
        buffers.set(f, await ctx.decodeAudioData(await res.arrayBuffer()));
      } catch {
        // No decodable audio stream (e.g. a silent video) — mixes as silence,
        // like the engine's hasStream check.
      }
    })
  );

  const hasSpeechSource =
    spec.clips.some((c) => !c.muted && buffers.has(c.file)) ||
    spec.audio.some((a) => buffers.has(a.file));
  if (!hasSpeechSource) return null;

  // First pass: the timeline geometry of the sequential clip fold. Each
  // cross-dissolve pulls the next clip back by the (clamped) overlap, exactly
  // like the engine's acrossfade chain.
  const geo = spec.clips.map((c) => ({ clip: c, at: 0, dur: clipDur(c), fadeIn: 0, fadeOut: 0 }));
  let acc = 0;
  geo.forEach((g, j) => {
    const d =
      j > 0 ? Math.min(spec.clips[j - 1].transition ?? 0, acc * 0.9, g.dur * 0.9) : 0;
    const fade = d > 0.01 ? d : 0;
    g.at = j === 0 ? 0 : acc - fade;
    g.fadeIn = fade;
    if (j > 0) geo[j - 1].fadeOut = fade;
    acc = g.at + g.dur;
  });

  for (const g of geo) {
    const c = g.clip;
    const buf = !c.muted && c.file ? buffers.get(c.file) : undefined;
    if (!buf) continue; // muted / silent clips and gap spacers only shape time
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = speedOf(c.speed);
    const gain = ctx.createGain();
    if (g.fadeIn > 0) {
      gain.gain.setValueAtTime(0, g.at);
      gain.gain.linearRampToValueAtTime(1, g.at + g.fadeIn);
    }
    if (g.fadeOut > 0) {
      gain.gain.setValueAtTime(1, g.at + g.dur - g.fadeOut);
      gain.gain.linearRampToValueAtTime(0, g.at + g.dur);
    }
    src.connect(gain);
    gain.connect(ctx.destination);
    // start()'s offset/duration are source seconds; playbackRate stretches
    // them onto the timeline, matching the engine's atrim + atempo.
    src.start(g.at, Math.max(0, c.in), Math.max(0, c.out - c.in));
  }

  for (const a of spec.audio) {
    const buf = buffers.get(a.file);
    if (!buf) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = speedOf(a.speed);
    const gain = ctx.createGain();
    gain.gain.value = a.volume;
    src.connect(gain);
    gain.connect(ctx.destination);
    src.start(Math.max(0, a.start), Math.max(0, a.in), Math.max(0, a.out - a.in));
  }

  return ctx.startRendering();
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

async function postChunk(
  samples: Float32Array,
  offset: number,
  locale: string | undefined
): Promise<WireCue[]> {
  const form = new FormData();
  form.append("audio", new File([encodeWav(samples)], "chunk.wav", { type: "audio/wav" }));
  form.append("offset", String(round(offset)));
  if (locale) form.append("locale", locale);
  const res = await apiFetch("/api/cut/transcribe", { method: "POST", body: form });
  const body = (await res.json().catch(() => null)) as
    | { cues?: WireCue[]; error?: string; message?: string }
    | null;
  if (!res.ok) throw new Error(body?.message ?? body?.error ?? "Transcription failed.");
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
  isStale?: () => boolean
): Promise<SubtitleCue[] | null> {
  const duration = samples.length / RATE;
  const step = (CHUNK_SECONDS - OVERLAP_SECONDS) * RATE;
  const cues: SubtitleCue[] = [];
  for (let s = 0; s < samples.length; s += step) {
    const slice = samples.subarray(s, Math.min(samples.length, s + CHUNK_SECONDS * RATE));
    const offset = s / RATE;
    const last = s + CHUNK_SECONDS * RATE >= samples.length;
    if (isStale?.()) return null;
    if (!isSilent(slice)) {
      const chunk = await postChunk(slice, offset, locale);
      if (isStale?.()) return null;
      const from = s === 0 ? -Infinity : offset + OVERLAP_SECONDS / 2;
      const to = last ? Infinity : offset + slice.length / RATE - OVERLAP_SECONDS / 2;
      for (const c of chunk) {
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
    if (last) break;
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
