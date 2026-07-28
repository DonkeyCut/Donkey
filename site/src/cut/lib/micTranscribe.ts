"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { hasLocalCompute } from "./backend";
import { localBackend } from "./backend/local";
import { cloudTranscribeRecording } from "./cloudTranscribe";

// Live dictation for the chat composer. The browser holds the mic permission,
// so it captures audio here and streams 16 kHz mono s16le PCM to the local
// engine, which runs it through Apple's on-device SpeechAnalyzer (see
// server/mic.ts + native/cut-stt.swift). The transcript never leaves the Mac.
// On the cloud backend there is no engine: the mic records locally
// (MediaRecorder) and one hosted transcription runs when the user confirms —
// no live partials, so the composer shows "Listening…" while recording.

export type MicState = "idle" | "starting" | "recording" | "finishing";

const TARGET_RATE = 16000; // must match cut-stt.swift's live input format
const FEED_MS = 250; // how often queued PCM is flushed to the engine
const POLL_MS = 150; // how often the evolving transcript is fetched

/** Average-downsample Float32 PCM to 16 kHz signed-16-bit little-endian. */
function toPcm16(input: Float32Array, srcRate: number): Int16Array {
  const ratio = srcRate / TARGET_RATE;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    const v = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

export interface MicController {
  state: MicState;
  /** Live stream while recording (for the waveform); null otherwise. */
  stream: MediaStream | null;
  /** Evolving transcript while recording. */
  partial: string;
  error: string | null;
  /** Begin capturing + transcribing. */
  start: () => Promise<void>;
  /** Finish, resolve the final transcript, and hand it to `onResult`. */
  confirm: () => Promise<void>;
  /** Discard the dictation. */
  cancel: () => void;
}

export function useMicTranscription(onResult: (text: string) => void): MicController {
  const [state, setState] = useState<MicState>("idle");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);

  const jobRef = useRef<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodesRef = useRef<{ source: MediaStreamAudioSourceNode; processor: ScriptProcessorNode } | null>(null);
  const queueRef = useRef<Int16Array[]>([]);
  const feedingRef = useRef(false);
  const feedTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  /** Stop and forget the cloud recorder (before its tracks stop). */
  const discardRecorder = useCallback(() => {
    const rec = recorderRef.current;
    recorderRef.current = null;
    recChunksRef.current = [];
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        // Already stopping; nothing to discard.
      }
    }
  }, []);

  const teardownAudio = useCallback(() => {
    if (feedTimer.current) clearInterval(feedTimer.current);
    if (pollTimer.current) clearInterval(pollTimer.current);
    feedTimer.current = null;
    pollTimer.current = null;
    nodesRef.current?.processor.disconnect();
    nodesRef.current?.source.disconnect();
    nodesRef.current = null;
    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    queueRef.current = [];
    feedingRef.current = false;
    setStream(null);
  }, []);

  /** Concatenate and POST all queued PCM. Guarded so chunks stay ordered. */
  const flush = useCallback(async () => {
    const job = jobRef.current;
    if (!job || feedingRef.current || queueRef.current.length === 0) return;
    feedingRef.current = true;
    const chunks = queueRef.current;
    queueRef.current = [];
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Int16Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    try {
      await localBackend.fetch(`/api/cut/mic/${job}/feed`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: merged.buffer,
      });
    } catch {
      // A dropped chunk just shortens the transcript; keep the dictation alive.
    } finally {
      feedingRef.current = false;
    }
  }, []);

  const start = useCallback(async () => {
    if (state !== "idle") return;
    setError(null);
    setPartial("");
    setState("starting");
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setState("idle");
      setError("Microphone access was blocked. Allow the microphone for this site, then try again.");
      return;
    }
    // Dictation runs on the Mac whenever the app is there — on-device, free,
    // and live — whatever backend holds the project. Without it the take is
    // recorded and sent to the hosted route in one go.
    if (!hasLocalCompute()) {
      recChunksRef.current = [];
      const rec = new MediaRecorder(media);
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) recChunksRef.current.push(e.data);
      };
      rec.start(1000);
      recorderRef.current = rec;
      streamRef.current = media;
      setStream(media);
      setState("recording");
      return;
    }
    try {
      const res = await localBackend.fetch("/api/cut/mic/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !data.id) throw new Error(data.error || "Dictation needs the Donkey app running on this Mac.");
      jobRef.current = data.id;
    } catch (e) {
      media.getTracks().forEach((t) => t.stop());
      setState("idle");
      setError(e instanceof Error ? e.message : "Could not start dictation.");
      return;
    }

    streamRef.current = media;
    setStream(media);

    const ctx = new AudioContext();
    void ctx.resume().catch(() => {});
    ctxRef.current = ctx;
    const source = ctx.createMediaStreamSource(media);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => {
      queueRef.current.push(toPcm16(e.inputBuffer.getChannelData(0), ctx.sampleRate));
    };
    // Route through a muted gain so onaudioprocess fires without echoing the mic.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(processor);
    processor.connect(mute);
    mute.connect(ctx.destination);
    nodesRef.current = { source, processor };

    feedTimer.current = setInterval(() => void flush(), FEED_MS);
    pollTimer.current = setInterval(async () => {
      const job = jobRef.current;
      if (!job) return;
      try {
        const res = await localBackend.fetch(`/api/cut/mic/${job}`);
        if (!res.ok) return;
        const data = (await res.json()) as { text?: string; status?: string; error?: string };
        if (typeof data.text === "string") setPartial(data.text);
        if (data.status === "error" && data.error) setError(data.error);
      } catch {
        // Transient poll failure; the next tick retries.
      }
    }, POLL_MS);

    setState("recording");
  }, [state, flush]);

  const confirm = useCallback(async () => {
    const rec = recorderRef.current;
    if (rec) {
      if (state !== "recording") return;
      setState("finishing");
      // Flush the recorder's tail, then transcribe the whole take in one go.
      const blob = await new Promise<Blob>((resolve) => {
        rec.onstop = () =>
          resolve(new Blob(recChunksRef.current, { type: rec.mimeType || "audio/webm" }));
        rec.stop();
      });
      recorderRef.current = null;
      recChunksRef.current = [];
      teardownAudio();
      let text = "";
      try {
        text = await cloudTranscribeRecording(blob, navigator.language);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Transcription failed.");
      }
      setState("idle");
      setPartial("");
      const trimmed = text.trim();
      if (trimmed) onResultRef.current(trimmed);
      return;
    }
    const job = jobRef.current;
    if (!job || state !== "recording") return;
    setState("finishing");
    // Stop pulling new audio, flush what's queued, then close the input so the
    // model emits its final text.
    nodesRef.current?.processor.disconnect();
    if (feedTimer.current) clearInterval(feedTimer.current);
    if (pollTimer.current) clearInterval(pollTimer.current);
    feedTimer.current = null;
    pollTimer.current = null;
    // Wait out any in-flight feed, then drain the tail.
    while (feedingRef.current) await new Promise((r) => setTimeout(r, 20));
    await flush();
    let text = "";
    try {
      const res = await localBackend.fetch(`/api/cut/mic/${job}/stop`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { text?: string };
      text = data.text ?? "";
    } catch {
      text = partial;
    }
    jobRef.current = null;
    teardownAudio();
    setState("idle");
    setPartial("");
    const trimmed = text.trim();
    if (trimmed) onResultRef.current(trimmed);
  }, [state, flush, partial, teardownAudio]);

  const cancel = useCallback(() => {
    const job = jobRef.current;
    jobRef.current = null;
    if (job) void localBackend.fetch(`/api/cut/mic/${job}/cancel`, { method: "POST" }).catch(() => {});
    discardRecorder();
    teardownAudio();
    setState("idle");
    setPartial("");
    setError(null);
  }, [discardRecorder, teardownAudio]);

  // Abandon a dictation if the composer unmounts mid-recording.
  useEffect(() => {
    return () => {
      const job = jobRef.current;
      if (job) void localBackend.fetch(`/api/cut/mic/${job}/cancel`, { method: "POST" }).catch(() => {});
      discardRecorder();
      teardownAudio();
    };
  }, [discardRecorder, teardownAudio]);

  return { state, stream, partial, error, start, confirm, cancel };
}
