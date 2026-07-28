"use client";

// On-device speech for a project the engine does not store. A cloud project's
// media lives in R2, so the browser renders its audible mix (cloudTranscribe.ts)
// and hands the audio to this Mac's engine instead of the metered hosted route.
// The engine answers with the same cues the local-project path produces —
// carrying real word timings, which the hosted route can only interpolate.

import { localBackend } from "./backend/local";
import { encodeWav } from "./cloudTranscribe";
import type { SubtitleCue } from "./types";

const POLL_MS = 700;

/** Transcribe a rendered mix on this Mac. Returns null when `isStale` trips
 * (the caller moved on); throws when the engine can't do it, which is the
 * caller's cue to fall back to the hosted route. */
export async function engineTranscribeSamples(
  samples: Float32Array,
  duration: number,
  locale: string | undefined,
  isStale?: () => boolean
): Promise<SubtitleCue[] | null> {
  const form = new FormData();
  form.append("audio", new File([encodeWav(samples)], "mix.wav", { type: "audio/wav" }));
  form.append("duration", String(duration));
  if (locale) form.append("locale", locale);
  const res = await localBackend.fetch("/api/cut/stt", { method: "POST", body: form });
  const body = (await res.json().catch(() => null)) as { id?: string; error?: string } | null;
  if (!res.ok || !body?.id) {
    throw new Error(body?.error ?? "On-device transcription failed to start.");
  }
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (isStale?.()) return null;
    const st = await localBackend.fetch(`/api/cut/stt/${body.id}`);
    if (!st.ok) throw new Error("The transcription job was lost.");
    const status = (await st.json()) as {
      status: string;
      error?: string;
      cues?: SubtitleCue[];
    };
    if (status.status === "error") throw new Error(status.error ?? "Transcription failed.");
    if (status.status === "done") return status.cues ?? [];
  }
}
