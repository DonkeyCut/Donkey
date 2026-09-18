"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
//
// Capture is an AudioWorklet. It downsamples on the audio thread and hands the
// main thread whole chunks, and it releases its partial chunk on request so the
// end of the last word reaches the model. A dictation that stops carrying audio
// — a graph that never started, feeds the engine refuses — ends with the reason
// on screen, because a session the engine never hears from produces nothing and
// waits for a transcript that will never come.

export type MicState = "idle" | "starting" | "recording" | "finishing";

const TARGET_RATE = 16000; // must match cut-stt.swift's live input format
const CHUNK_MS = 250; // how much PCM the worklet batches into one message
const FEED_MS = 250; // how often queued PCM is flushed to the engine
const POLL_MS = 150; // how often the evolving transcript is fetched
// Capture that has delivered nothing by here never will: the graph is dead, and
// waiting longer turns a failure the user can act on into a silent one. Both
// paths are held to it — the worklet's first chunk, the recorder's first blob.
const FIRST_AUDIO_MS = 2500;
// How often MediaRecorder hands over what it has on the hosted path.
const RECORDER_SLICE_MS = 1000;
// How long that recorder may take to report its stop before the take is read
// from the blobs already in hand.
const STOP_RECORDER_MS = 1500;
// Feeds drop transiently; a run of them means the audio is going nowhere.
const MAX_FEED_FAILURES = 3;
// How long the worklet's tail chunk may take once the flush is asked for.
const TAIL_MS = 400;

/** The capture graph, as an AudioWorklet module. It averages the mic's native
 * rate down to 16 kHz signed-16-bit PCM on the audio thread and posts whole
 * chunks; a "flush" message releases the partial chunk that is still forming,
 * so the tail of the take is not dropped at the cut. */
const PCM_WORKLET = `
class MicPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / ${TARGET_RATE};
    this.size = Math.round((${TARGET_RATE} * ${CHUNK_MS}) / 1000);
    this.out = new Int16Array(this.size);
    this.filled = 0;
    this.sum = 0;
    this.count = 0;
    this.acc = 0;
    this.port.onmessage = (e) => {
      if (e.data === "flush") this.send(true);
    };
  }
  send(last) {
    const pcm = this.out.slice(0, this.filled);
    this.filled = 0;
    this.port.postMessage({ pcm, last }, [pcm.buffer]);
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i];
      this.count++;
      this.acc++;
      if (this.acc < this.ratio) continue;
      this.acc -= this.ratio;
      const v = Math.max(-1, Math.min(1, this.sum / this.count));
      this.out[this.filled++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      this.sum = 0;
      this.count = 0;
      if (this.filled === this.size) this.send(false);
    }
    return true;
  }
}
registerProcessor("mic-pcm", MicPcm);
`;

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
  const nodesRef = useRef<{ source: MediaStreamAudioSourceNode; node: AudioWorkletNode } | null>(null);
  const queueRef = useRef<Int16Array[]>([]);
  const feedingRef = useRef(false);
  const failuresRef = useRef(0);
  /** Whether capture has delivered anything at all — the liveness test that
   * separates a quiet room from a capture that never ran. */
  const gotAudioRef = useRef(false);
  /** Resolves the pending tail flush when the worklet's last chunk arrives. */
  const tailRef = useRef<(() => void) | null>(null);
  const feedTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const silenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onResultRef = useRef(onResult);
  useLayoutEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

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
    if (silenceTimer.current) clearTimeout(silenceTimer.current);
    feedTimer.current = null;
    pollTimer.current = null;
    silenceTimer.current = null;
    tailRef.current = null;
    const nodes = nodesRef.current;
    nodesRef.current = null;
    if (nodes) {
      nodes.node.port.onmessage = null;
      nodes.node.disconnect();
      nodes.source.disconnect();
    }
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx) {
      ctx.onstatechange = null;
      void ctx.close().catch(() => {});
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    queueRef.current = [];
    feedingRef.current = false;
    failuresRef.current = 0;
    gotAudioRef.current = false;
    setStream(null);
  }, []);

  /** Hand the session back and put the reason on screen. Everything that can
   * leave a dictation unable to carry audio ends here, so the engine never
   * holds a session nothing is feeding and the user is never left watching an
   * empty transcript. */
  const fail = useCallback(
    (message: string) => {
      const job = jobRef.current;
      jobRef.current = null;
      if (job) void localBackend.fetch(`/api/cut/mic/${job}/cancel`, { method: "POST" }).catch(() => {});
      discardRecorder();
      teardownAudio();
      setState("idle");
      setPartial("");
      setError(message);
    },
    [discardRecorder, teardownAudio]
  );

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
      const res = await localBackend.fetch(`/api/cut/mic/${job}/feed`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: merged.buffer,
      });
      if (!res.ok) throw new Error(`Donkey turned the audio away (${res.status}).`);
      failuresRef.current = 0;
    } catch (e) {
      // A dropped chunk just shortens the transcript; a run of them means the
      // audio is reaching nothing, and the dictation says so.
      failuresRef.current += 1;
      if (failuresRef.current >= MAX_FEED_FAILURES) {
        fail(e instanceof Error ? e.message : "Donkey stopped receiving the audio.");
      }
    } finally {
      feedingRef.current = false;
    }
  }, [fail]);

  /** Ask the worklet for the chunk still forming, so the last word is whole. */
  const drainTail = useCallback(async () => {
    const node = nodesRef.current?.node;
    if (!node) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        tailRef.current = null;
        resolve();
      }, TAIL_MS);
      tailRef.current = () => {
        clearTimeout(timer);
        tailRef.current = null;
        resolve();
      };
      node.port.postMessage("flush");
    });
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
    streamRef.current = media;
    // Dictation runs on the Mac whenever the app is there — on-device, free,
    // and live — whatever backend holds the project. Without it the take is
    // recorded and sent to the hosted route in one go, under the same contract:
    // a recorder that cannot start, that dies mid-take, or that hands over
    // nothing ends the dictation with the reason on screen.
    if (!hasLocalCompute()) {
      try {
        recChunksRef.current = [];
        const rec = new MediaRecorder(media);
        rec.ondataavailable = (e) => {
          if (e.data.size === 0) return;
          gotAudioRef.current = true;
          recChunksRef.current.push(e.data);
        };
        rec.onerror = () => fail("The browser stopped recording the microphone.");
        rec.start(RECORDER_SLICE_MS);
        recorderRef.current = rec;
      } catch (e) {
        teardownAudio();
        setState("idle");
        setError(e instanceof Error ? e.message : "This browser could not record the microphone.");
        return;
      }
      setStream(media);
      silenceTimer.current = setTimeout(() => {
        if (gotAudioRef.current) return;
        fail("No audio is reaching Donkey from this microphone. Check the input device and try again.");
      }, FIRST_AUDIO_MS);
      setState("recording");
      return;
    }
    let jobId: string;
    try {
      const res = await localBackend.fetch("/api/cut/mic/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: navigator.language }),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !data.id) throw new Error(data.error || "Dictation needs the Donkey app running on this Mac.");
      jobId = data.id;
      jobRef.current = jobId;
    } catch (e) {
      teardownAudio();
      setState("idle");
      setError(e instanceof Error ? e.message : "Could not start dictation.");
      return;
    }

    // The engine now holds a session, so a capture that cannot be built hands
    // it back here instead of leaving a process waiting on audio.
    try {
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      await ctx.resume();
      if (ctx.state !== "running") throw new Error("This page is not allowed to capture audio right now.");
      const url = URL.createObjectURL(new Blob([PCM_WORKLET], { type: "text/javascript" }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(ctx, "mic-pcm", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      node.port.onmessage = (e: MessageEvent<{ pcm: Int16Array; last: boolean }>) => {
        gotAudioRef.current = true;
        if (e.data.pcm.length > 0) queueRef.current.push(e.data.pcm);
        if (e.data.last) tailRef.current?.();
      };
      // Web Audio pulls the graph from the destination, so the tap reaches it
      // through a silent gain: the node runs, and nothing echoes the mic.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      const source = ctx.createMediaStreamSource(media);
      source.connect(node);
      node.connect(mute);
      mute.connect(ctx.destination);
      nodesRef.current = { source, node };
      // A context that leaves "running" mid-take stops delivering audio and
      // says nothing; the dictation ends on the state change instead of on a
      // transcript that quietly stopped growing.
      ctx.onstatechange = () => {
        if (ctxRef.current === ctx && ctx.state !== "running") {
          fail("The browser stopped audio capture for this page.");
        }
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : "This browser could not capture the microphone.";
      fail(message);
      return;
    }

    setStream(media);

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
    silenceTimer.current = setTimeout(() => {
      if (gotAudioRef.current) return;
      fail("No audio is reaching Donkey from this microphone. Check the input device and try again.");
    }, FIRST_AUDIO_MS);

    setState("recording");
  }, [state, flush, fail, teardownAudio]);

  const confirm = useCallback(async () => {
    const rec = recorderRef.current;
    if (rec) {
      if (state !== "recording") return;
      setState("finishing");
      // Flush the recorder's tail, then transcribe the whole take in one go. A
      // recorder that never reports its stop cannot hold the composer: whatever
      // it has handed over by the deadline is the take.
      const blob = await new Promise<Blob>((resolve) => {
        const settle = () =>
          resolve(new Blob(recChunksRef.current, { type: rec.mimeType || "audio/webm" }));
        const timer = setTimeout(settle, STOP_RECORDER_MS);
        rec.onstop = () => {
          clearTimeout(timer);
          settle();
        };
        try {
          rec.stop();
        } catch {
          clearTimeout(timer);
          settle();
        }
      });
      recorderRef.current = null;
      recChunksRef.current = [];
      teardownAudio();
      if (blob.size === 0) {
        setState("idle");
        setPartial("");
        setError("Nothing was recorded from the microphone.");
        return;
      }
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
    // Stop pulling new audio, take the chunk the worklet is still filling,
    // flush what's queued, then close the input so the model emits its final
    // text.
    if (feedTimer.current) clearInterval(feedTimer.current);
    if (pollTimer.current) clearInterval(pollTimer.current);
    if (silenceTimer.current) clearTimeout(silenceTimer.current);
    feedTimer.current = null;
    pollTimer.current = null;
    silenceTimer.current = null;
    nodesRef.current?.source.disconnect();
    await drainTail();
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
  }, [state, flush, partial, teardownAudio, drainTail]);

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
