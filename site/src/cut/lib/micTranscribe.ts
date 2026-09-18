"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { confirmEngine } from "./api";
import { hasLocalCompute } from "./backend";
import { localBackend } from "./backend/local";
import { cloudTranscribeRecording } from "./cloudTranscribe";

// Live dictation for the chat composer. The browser holds the mic permission,
// so capture happens in the page, and the transcription runs wherever it can.
//
// Every take is recorded here (MediaRecorder) for the whole dictation — that
// recording is the floor under the feature. On a Mac with the app, the same
// audio also streams to the engine as 16 kHz mono s16le PCM for Apple's
// on-device SpeechAnalyzer (server/mic.ts + native/cut-stt.swift), which gives
// live partials and keeps the speech on the machine. Where the engine is
// absent, and the moment it stops carrying a dictation already under way, the
// recording goes to the hosted route on confirm and the composer shows
// "Listening…" until it answers. Dictation works on every surface; which
// transcriber served it is the only difference the user can see.
//
// Capture is an AudioWorklet. It downsamples on the audio thread and hands the
// main thread whole chunks, and it releases its partial chunk on request so the
// end of the last word reaches the model. A dictation that stops carrying audio
// at all — a graph that never started, a microphone delivering nothing — ends
// with the reason on screen, because a session nothing feeds produces nothing
// and waits for a transcript that will never come.

export type MicState = "idle" | "starting" | "recording" | "finishing";

/** Which transcriber is carrying the dictation: this Mac's engine, live, or
 * the hosted route reading the recording once the user confirms. */
type MicMode = "engine" | "hosted";

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
  /** Which transcriber this dictation is on; a run that loses the engine flips
   * it to "hosted" without the user doing anything. */
  const modeRef = useRef<MicMode>("hosted");
  /** The newest partial, kept outside React so a hosted transcription that
   * fails can still hand back what the engine had said. */
  const partialRef = useRef("");
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

  /** Stop and forget the recorded take (before its tracks stop). */
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

  /** Drop the live capture that feeds the engine — worklet, context, timers —
   * and leave the microphone and the recording running. This is what a
   * dictation sheds when it moves off the engine mid-sentence. */
  const teardownEngine = useCallback(() => {
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
    queueRef.current = [];
    feedingRef.current = false;
    failuresRef.current = 0;
  }, []);

  const teardownAudio = useCallback(() => {
    discardRecorder();
    teardownEngine();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    gotAudioRef.current = false;
    setStream(null);
  }, [discardRecorder, teardownEngine]);

  /** Hand the session back and put the reason on screen. Everything that can
   * leave a dictation with no transcriber and no recording ends here, so the
   * engine never holds a session nothing is feeding and the user is never left
   * watching an empty transcript. */
  const fail = useCallback(
    (message: string) => {
      const job = jobRef.current;
      jobRef.current = null;
      if (job) void localBackend.fetch(`/api/cut/mic/${job}/cancel`, { method: "POST" }).catch(() => {});
      teardownAudio();
      setState("idle");
      setPartial("");
      partialRef.current = "";
      setError(message);
    },
    [teardownAudio]
  );

  /** Capture that has delivered nothing by the deadline never will; say so
   * rather than leaving the user watching an empty transcript. */
  const armSilence = useCallback(() => {
    if (silenceTimer.current) clearTimeout(silenceTimer.current);
    silenceTimer.current = setTimeout(() => {
      if (gotAudioRef.current) return;
      fail("No audio is reaching Donkey from this microphone. Check the input device and try again.");
    }, FIRST_AUDIO_MS);
  }, [fail]);

  /** Record the take in the page. Every dictation runs this: on the Mac it is
   * the net under the engine's live transcript, and everywhere else it is the
   * dictation itself. */
  const startRecorder = useCallback(
    (media: MediaStream): boolean => {
      try {
        recChunksRef.current = [];
        const rec = new MediaRecorder(media);
        rec.ondataavailable = (e) => {
          if (e.data.size === 0) return;
          gotAudioRef.current = true;
          recChunksRef.current.push(e.data);
        };
        rec.onerror = () => {
          recorderRef.current = null;
          // The engine is still transcribing this one; only a dictation the
          // recording *was* has nothing left to finish with.
          if (modeRef.current === "hosted") fail("The browser stopped recording the microphone.");
        };
        rec.start(RECORDER_SLICE_MS);
        recorderRef.current = rec;
        return true;
      } catch {
        return false;
      }
    },
    [fail]
  );

  /** The engine stopped carrying this dictation. Hand its session back, drop
   * the live capture, and let the recording finish the job on the hosted route
   * when the user confirms — the microphone keeps running and nothing on
   * screen changes but the partial. Returns false when there was no recording
   * to fall back on, in which case the dictation ended with `reason` shown. */
  const degrade = useCallback(
    (reason: string): boolean => {
      if (!recorderRef.current) {
        fail(reason);
        return false;
      }
      const job = jobRef.current;
      jobRef.current = null;
      if (job) void localBackend.fetch(`/api/cut/mic/${job}/cancel`, { method: "POST" }).catch(() => {});
      // The app may have quit under the dictation; let the gate settle that
      // once instead of leaving every other surface to find out on its own.
      void confirmEngine();
      modeRef.current = "hosted";
      teardownEngine();
      setPartial("");
      partialRef.current = "";
      if (!gotAudioRef.current) armSilence();
      return true;
    },
    [fail, teardownEngine, armSilence]
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
      // engine is no longer taking this dictation, and the recording takes over.
      failuresRef.current += 1;
      if (failuresRef.current >= MAX_FEED_FAILURES) {
        degrade(e instanceof Error ? e.message : "Donkey stopped receiving the audio.");
      }
    } finally {
      feedingRef.current = false;
    }
  }, [degrade]);

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

  /** Read the evolving transcript off the engine's session. */
  const pollEngine = useCallback(async () => {
    const job = jobRef.current;
    if (!job) return;
    try {
      const res = await localBackend.fetch(`/api/cut/mic/${job}`);
      if (!res.ok) return;
      const data = (await res.json()) as { text?: string; status?: string; error?: string };
      if (typeof data.text === "string") {
        partialRef.current = data.text;
        setPartial(data.text);
      }
      // A session that died — a locale with no model on this Mac, a process
      // that quit — has no transcript coming; the recording carries it instead.
      if (data.status === "error") degrade(data.error || "Dictation stopped on this Mac.");
    } catch {
      // Transient poll failure; the next tick retries. An engine that is gone
      // shows up in the feeds, which are what carry the audio.
    }
  }, [degrade]);

  /** Open a dictation on this Mac's engine. False when it cannot take one. */
  const startEngineSession = useCallback(async (): Promise<boolean> => {
    try {
      const res = await localBackend.fetch("/api/cut/mic/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: navigator.language }),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string };
      if (!res.ok || !data.id) return false;
      jobRef.current = data.id;
      return true;
    } catch {
      // The app quit since the gate connected; settle that and go hosted.
      void confirmEngine();
      return false;
    }
  }, []);

  /** Build the live capture graph that streams PCM to the engine. False when
   * the dictation ended here, its reason already on screen. */
  const buildCapture = useCallback(
    async (media: MediaStream): Promise<boolean> => {
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
        // says nothing; the dictation moves off the engine on the state change
        // instead of on a transcript that quietly stopped growing.
        ctx.onstatechange = () => {
          if (ctxRef.current === ctx && ctx.state !== "running") {
            degrade("The browser stopped audio capture for this page.");
          }
        };
        return true;
      } catch (e) {
        return degrade(e instanceof Error ? e.message : "This browser could not capture the microphone.");
      }
    },
    [degrade]
  );

  const start = useCallback(async () => {
    if (state !== "idle") return;
    setError(null);
    setPartial("");
    partialRef.current = "";
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
    const recording = startRecorder(media);
    // Dictation runs on the Mac whenever the app is there — on-device, free,
    // and live — whatever backend holds the project. The result still lands
    // through the project's own backend, so where the speech ran never decides
    // where the text goes.
    const onEngine = hasLocalCompute() && (await startEngineSession());
    modeRef.current = onEngine ? "engine" : "hosted";
    // The engine now holds a session, so a capture graph that cannot be built
    // hands it back rather than leaving a process waiting on audio.
    if (onEngine && !(await buildCapture(media))) return;
    if (modeRef.current === "hosted" && !recording) {
      teardownAudio();
      setState("idle");
      setError("This browser could not record the microphone.");
      return;
    }
    setStream(media);
    if (modeRef.current === "engine") {
      feedTimer.current = setInterval(() => void flush(), FEED_MS);
      pollTimer.current = setInterval(() => void pollEngine(), POLL_MS);
    }
    armSilence();
    setState("recording");
  }, [state, startRecorder, startEngineSession, buildCapture, teardownAudio, flush, pollEngine, armSilence]);

  /** Close the engine's session and take its final transcript. Null when the
   * engine could not answer, leaving the recording to carry the dictation. */
  const finishEngine = useCallback(async (): Promise<string | null> => {
    const job = jobRef.current;
    if (!job) return null;
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
    // Wait out any in-flight feed, then send what the tail added.
    while (feedingRef.current) await new Promise((r) => setTimeout(r, 20));
    await flush();
    jobRef.current = null;
    try {
      const res = await localBackend.fetch(`/api/cut/mic/${job}/stop`, { method: "POST" });
      if (!res.ok) return null;
      const data = (await res.json().catch(() => ({}))) as { text?: string };
      return data.text ?? "";
    } catch {
      void confirmEngine();
      return null;
    }
  }, [drainTail, flush]);

  /** Close the recording and transcribe the whole take on the hosted route. */
  const finishHosted = useCallback(async (): Promise<string> => {
    const rec = recorderRef.current;
    recorderRef.current = null;
    // Flush the recorder's tail. A recorder that never reports its stop cannot
    // hold the composer: whatever it has handed over by the deadline is the take.
    if (rec && rec.state !== "inactive") {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, STOP_RECORDER_MS);
        rec.onstop = () => {
          clearTimeout(timer);
          resolve();
        };
        try {
          rec.stop();
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    }
    const blob = new Blob(recChunksRef.current, { type: rec?.mimeType || "audio/webm" });
    recChunksRef.current = [];
    teardownAudio();
    if (blob.size === 0) {
      setError("Nothing was recorded from the microphone.");
      return "";
    }
    try {
      return await cloudTranscribeRecording(blob, navigator.language);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transcription failed.");
      // Whatever the engine had said before it dropped out beats nothing.
      return partialRef.current;
    }
  }, [teardownAudio]);

  const confirm = useCallback(async () => {
    if (state !== "recording") return;
    setState("finishing");
    let text: string | null = null;
    if (modeRef.current === "engine") {
      text = await finishEngine();
      // The engine carried it; the recording was only the net under it.
      if (text !== null) teardownAudio();
    }
    if (text === null) text = await finishHosted();
    setState("idle");
    setPartial("");
    partialRef.current = "";
    const trimmed = text.trim();
    if (trimmed) onResultRef.current(trimmed);
  }, [state, finishEngine, finishHosted, teardownAudio]);

  const cancel = useCallback(() => {
    const job = jobRef.current;
    jobRef.current = null;
    if (job) void localBackend.fetch(`/api/cut/mic/${job}/cancel`, { method: "POST" }).catch(() => {});
    teardownAudio();
    setState("idle");
    setPartial("");
    partialRef.current = "";
    setError(null);
  }, [teardownAudio]);

  // Abandon a dictation if the composer unmounts mid-recording.
  useEffect(() => {
    return () => {
      const job = jobRef.current;
      if (job) void localBackend.fetch(`/api/cut/mic/${job}/cancel`, { method: "POST" }).catch(() => {});
      teardownAudio();
    };
  }, [teardownAudio]);

  return { state, stream, partial, error, start, confirm, cancel };
}
