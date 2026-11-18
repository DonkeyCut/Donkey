"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { confirmEngine } from "./api";
import { hasLocalCompute } from "./backend";
import { localBackend } from "./backend/local";
import { transcribePhrase } from "./cloudTranscribe";
import { PhraseCutter } from "./phraseCutter";
import { UserError } from "./userError";

// Live dictation for every voice input. The browser holds the mic permission,
// so capture happens in the page, and the transcription runs wherever it can.
// Either way the words appear while the user speaks.
//
// One capture graph, an AudioWorklet, turns the mic into 16 kHz mono s16le
// PCM on the audio thread. On a Mac with the app, that PCM streams to the
// engine for Apple's on-device SpeechAnalyzer (server/mic.ts +
// native/cut-stt.swift), which keeps the speech on the machine; the page holds
// the take as it goes, so the moment the engine stops carrying a dictation the
// whole take moves to the hosted route. Without the engine, PhraseCutter cuts
// the PCM at the speaker's pauses and each phrase goes to the hosted route as
// soon as it ends, its words landing while the next phrase is spoken.
//
// The worklet releases its partial chunk on request so the end of the last
// word reaches the transcriber. A dictation that stops carrying audio at all —
// a graph that never started, a microphone delivering nothing — ends with the
// reason on screen, because a session nothing feeds produces nothing and waits
// for a transcript that will never come.

export type MicState = "idle" | "starting" | "recording" | "finishing";

/** Which transcriber is carrying the dictation: this Mac's engine, or the
 * hosted route a phrase at a time. */
type MicMode = "engine" | "hosted";

const TARGET_RATE = 16000; // must match cut-stt.swift's live input format
const CHUNK_MS = 250; // how much PCM the worklet batches into one message
const FEED_MS = 250; // how often queued PCM is flushed to the engine
const POLL_MS = 150; // how often the evolving transcript is fetched
// Capture that has delivered nothing by here never will: the graph is dead, and
// waiting longer turns a failure the user can act on into a silent one.
const FIRST_AUDIO_MS = 2500;
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
  /** Why the last dictation ended, worded by the panel: a coded UserError
   * (errors catalog) or the engine's or browser's own error. */
  error: Error | null;
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
  const [error, setError] = useState<Error | null>(null);

  /** The state as async callbacks see it: a phrase that fails or a capture
   * that stops reads the live value, never the one its closure was made in. */
  const stateRef = useRef<MicState>("idle");
  const phase = useCallback((next: MicState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const jobRef = useRef<string | null>(null);
  /** Which transcriber this dictation is on; a run that loses the engine flips
   * it to "hosted" without the user doing anything. */
  const modeRef = useRef<MicMode>("hosted");
  /** The newest transcript, kept outside React for the finish to read. */
  const partialRef = useRef("");
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

  /** The take so far while the engine carries it: the net that lets the
   * hosted route pick the whole take up if the engine drops it. */
  const takeRef = useRef<Int16Array[]>([]);
  /** What the engine had said when the take moved off it. */
  const engineSaidRef = useRef("");
  /** Hosted mode: the pause cutter, each phrase's text in take order (null
   * while in flight), the requests still out, and the first failure. */
  const cutterRef = useRef<PhraseCutter | null>(null);
  const phrasesRef = useRef<(string | null)[]>([]);
  const pendingRef = useRef(new Set<Promise<void>>());
  const hostedErrorRef = useRef<Error | null>(null);
  /** Bumped whenever a dictation ends, so a phrase answering late lands nowhere. */
  const sessionRef = useRef(0);

  const onResultRef = useRef(onResult);
  useLayoutEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  /** Stop the engine's feed and poll timers. */
  const stopEngineTimers = useCallback(() => {
    if (feedTimer.current) clearInterval(feedTimer.current);
    if (pollTimer.current) clearInterval(pollTimer.current);
    feedTimer.current = null;
    pollTimer.current = null;
  }, []);

  /** Release everything the dictation holds: timers, graph, microphone, and
   * the take. */
  const teardownAudio = useCallback(() => {
    sessionRef.current += 1;
    stopEngineTimers();
    queueRef.current = [];
    feedingRef.current = false;
    failuresRef.current = 0;
    if (silenceTimer.current) clearTimeout(silenceTimer.current);
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
    gotAudioRef.current = false;
    takeRef.current = [];
    engineSaidRef.current = "";
    cutterRef.current = null;
    phrasesRef.current = [];
    pendingRef.current.clear();
    hostedErrorRef.current = null;
    setStream(null);
  }, [stopEngineTimers]);

  /** Hand the engine its session back without waiting for an answer. */
  const releaseJob = useCallback(() => {
    const job = jobRef.current;
    jobRef.current = null;
    if (job) void localBackend.fetch(`/api/cut/mic/${job}/cancel`, { method: "POST" }).catch(() => {});
  }, []);

  /** End the dictation with nothing delivered and the reason on screen. */
  const fail = useCallback(
    (message: Error) => {
      releaseJob();
      teardownAudio();
      phase("idle");
      setPartial("");
      partialRef.current = "";
      setError(message);
    },
    [releaseJob, teardownAudio, phase]
  );

  /** Capture that has delivered nothing by the deadline never will; say so
   * rather than leaving the user watching an empty transcript. */
  const armSilence = useCallback(() => {
    if (silenceTimer.current) clearTimeout(silenceTimer.current);
    silenceTimer.current = setTimeout(() => {
      if (gotAudioRef.current) return;
      fail(new UserError("mic_no_audio", "No audio is reaching Donkey from this microphone. Check the input device and try again."));
    }, FIRST_AUDIO_MS);
  }, [fail]);

  // `finish` is defined below and a failing phrase needs it; the ref breaks
  // the cycle between them.
  const finishRef = useRef<(reason?: Error) => Promise<void>>(async () => {});

  /** Send one phrase to the hosted route and show its words when they land.
   * The first failure ends the take with what it has; nothing more goes out. */
  const sendPhrase = useCallback((pcm: Int16Array) => {
    if (hostedErrorRef.current) return;
    const session = sessionRef.current;
    const slot = phrasesRef.current.push(null) - 1;
    const sent: Promise<void> = transcribePhrase(pcm, navigator.language)
      .then((text) => {
        if (session !== sessionRef.current) return;
        phrasesRef.current[slot] = text;
        const said = phrasesRef.current.filter(Boolean).join(" ");
        partialRef.current = said;
        setPartial(said);
      })
      .catch((e: unknown) => {
        if (session !== sessionRef.current || hostedErrorRef.current) return;
        const reason = e instanceof Error ? e : new UserError("mic_transcription_failed", "Transcription failed.");
        hostedErrorRef.current = reason;
        void finishRef.current(reason);
      })
      .finally(() => {
        pendingRef.current.delete(sent);
      });
    pendingRef.current.add(sent);
  }, []);

  /** Route one chunk of captured PCM to whichever transcriber has the take. */
  const onPcm = useCallback(
    (pcm: Int16Array) => {
      if (modeRef.current === "engine") {
        queueRef.current.push(pcm);
        takeRef.current.push(pcm);
        return;
      }
      for (const phrase of cutterRef.current?.push(pcm) ?? []) {
        sendPhrase(phrase);
      }
    },
    [sendPhrase]
  );

  /** Move the take onto the hosted route: everything captured so far is cut
   * into phrases and sent, and capture keeps feeding the cutter from here. */
  const goHosted = useCallback(() => {
    if (modeRef.current === "engine") engineSaidRef.current = partialRef.current;
    modeRef.current = "hosted";
    stopEngineTimers();
    queueRef.current = [];
    const take = takeRef.current;
    takeRef.current = [];
    cutterRef.current = new PhraseCutter();
    for (const pcm of take) onPcm(pcm);
  }, [stopEngineTimers, onPcm]);

  /** The engine stopped carrying this dictation. Hand its session back and
   * let the hosted route take the whole take from the start — the microphone
   * keeps running and nothing on screen changes but who supplies the words. */
  const degrade = useCallback(() => {
    releaseJob();
    // The app may have quit under the dictation; let the gate settle that
    // once instead of leaving every other surface to find out on its own.
    void confirmEngine();
    goHosted();
  }, [releaseJob, goHosted]);

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
      if (!res.ok) throw new UserError("mic_audio_refused", `Donkey turned the audio away (${res.status}).`, { status: res.status });
      failuresRef.current = 0;
    } catch {
      // A dropped chunk just shortens the transcript; a run of them means the
      // engine is no longer taking this dictation, and the hosted route takes over.
      failuresRef.current += 1;
      if (failuresRef.current >= MAX_FEED_FAILURES && jobRef.current === job) degrade();
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
      if (!res.ok || jobRef.current !== job) return;
      const data = (await res.json()) as { text?: string; status?: string; error?: string };
      if (typeof data.text === "string") {
        partialRef.current = data.text;
        setPartial(data.text);
      }
      // A session that died — a locale with no model on this Mac, a process
      // that quit — has no transcript coming; the hosted route carries it.
      if (data.status === "error") degrade();
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

  /** Build the capture graph. False when the dictation ended here, its reason
   * already on screen. */
  const buildCapture = useCallback(
    async (media: MediaStream): Promise<boolean> => {
      try {
        const ctx = new AudioContext();
        ctxRef.current = ctx;
        await ctx.resume();
        if (ctx.state !== "running") throw new UserError("mic_capture_denied", "This page is not allowed to capture audio right now.");
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
          if (e.data.pcm.length > 0) onPcm(e.data.pcm);
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
        // says nothing; the take ends there with what it has, and the reason.
        ctx.onstatechange = () => {
          if (ctxRef.current === ctx && ctx.state !== "running") {
            void finishRef.current(new UserError("mic_capture_stopped", "The browser stopped audio capture for this page."));
          }
        };
        return true;
      } catch (e) {
        fail(e instanceof Error ? e : new UserError("mic_capture_failed", "This browser could not capture the microphone."));
        return false;
      }
    },
    [onPcm, fail]
  );

  const start = useCallback(async () => {
    if (stateRef.current !== "idle") return;
    setError(null);
    setPartial("");
    partialRef.current = "";
    phase("starting");
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      phase("idle");
      setError(new UserError("mic_blocked", "Microphone access was blocked. Allow the microphone for this site, then try again."));
      return;
    }
    streamRef.current = media;
    // Dictation runs on the Mac whenever the app is there — on-device, free,
    // and live — whatever backend holds the project. The result still lands
    // through the project's own backend, so where the speech ran never decides
    // where the text goes.
    const onEngine = hasLocalCompute() && (await startEngineSession());
    modeRef.current = onEngine ? "engine" : "hosted";
    cutterRef.current = onEngine ? null : new PhraseCutter();
    if (!(await buildCapture(media))) return;
    setStream(media);
    if (onEngine) {
      feedTimer.current = setInterval(() => void flush(), FEED_MS);
      pollTimer.current = setInterval(() => void pollEngine(), POLL_MS);
    }
    armSilence();
    phase("recording");
  }, [phase, startEngineSession, buildCapture, flush, pollEngine, armSilence]);

  /** Close the engine's session and take its final transcript. Null when the
   * engine could not answer, leaving the hosted route to carry the take. */
  const finishEngine = useCallback(async (): Promise<string | null> => {
    const job = jobRef.current;
    if (!job) return null;
    // Flush what's queued, waiting out any in-flight feed, then close the
    // input so the model emits its final text.
    stopEngineTimers();
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
  }, [stopEngineTimers, flush]);

  /** Send the open phrase and wait for every phrase still out. */
  const finishHosted = useCallback(async (): Promise<string> => {
    const last = cutterRef.current?.flush();
    if (last) sendPhrase(last);
    while (pendingRef.current.size > 0) await Promise.all([...pendingRef.current]);
    const said = phrasesRef.current.filter(Boolean).join(" ");
    // Whatever the engine had said before it dropped out beats nothing.
    return said || (hostedErrorRef.current ? engineSaidRef.current : "");
  }, [sendPhrase]);

  /** End the take and deliver its transcript. `reason` is why the take ended
   * early — a failed phrase, a capture that stopped — shown once it lands. */
  const finish = useCallback(
    async (reason?: Error) => {
      if (stateRef.current !== "recording") return;
      phase("finishing");
      if (silenceTimer.current) clearTimeout(silenceTimer.current);
      silenceTimer.current = null;
      // Stop pulling new audio and take the chunk the worklet is still filling.
      nodesRef.current?.source.disconnect();
      await drainTail();
      let text: string | null = null;
      if (modeRef.current === "engine") text = await finishEngine();
      if (text === null) {
        if (modeRef.current === "engine") goHosted();
        text = await finishHosted();
      }
      const failure = reason ?? hostedErrorRef.current;
      teardownAudio();
      phase("idle");
      setPartial("");
      partialRef.current = "";
      if (failure) setError(failure);
      const trimmed = text.trim();
      if (trimmed) onResultRef.current(trimmed);
    },
    [phase, drainTail, finishEngine, goHosted, finishHosted, teardownAudio]
  );
  useLayoutEffect(() => {
    finishRef.current = finish;
  }, [finish]);

  const confirm = useCallback(() => finish(), [finish]);

  const cancel = useCallback(() => {
    releaseJob();
    teardownAudio();
    phase("idle");
    setPartial("");
    partialRef.current = "";
    setError(null);
  }, [releaseJob, teardownAudio, phase]);

  // Abandon a dictation if the composer unmounts mid-recording.
  useEffect(() => {
    return () => {
      releaseJob();
      teardownAudio();
    };
  }, [releaseJob, teardownAudio]);

  return { state, stream, partial, error, start, confirm, cancel };
}
