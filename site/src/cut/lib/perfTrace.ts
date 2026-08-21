"use client";

/**
 * What the preview actually did, frame by frame.
 *
 * Scrub latency and a stutter at a cut are both claims about time, and neither
 * can be settled by watching. This records the two facts that settle them: when
 * a time was asked for, and when a frame for that time reached the screen. From
 * those, "the picture is one frame behind the pointer" and "the join dropped a
 * frame" become numbers a script can hold to a budget.
 *
 * The trace is off until something arms it, and while it is off every call here
 * is a null check. The perf eval arms it through `window.__cutPerf`, and so can
 * a person on a machine we cannot reproduce: `__cutPerf.start()`, play the part
 * that stutters, then `__cutPerf.report()` for a summary small enough to paste
 * into a bug report. Nothing turns it on by itself.
 */

/** One composited frame that reached the canvas. */
export interface PresentRecord {
  /** Timeline time the frame was composited for. */
  t: number;
  /** When it was painted, on the `performance.now()` clock. */
  at: number;
  /** Source timestamp of the master layer's picture, for spotting a frame that
   * was shown twice or skipped. */
  srcTs: number | null;
  /**
   * The source time the master layer was asked for.
   *
   * With `srcTs` this is how far the picture sits behind the clock it is drawn
   * against. That clock is the audible one — see `audioLead` for the separate
   * question of whether the preview is reading it, which this cannot see: a
   * picture drawn against the wrong clock is exactly on time against it.
   */
  wantSrc: number | null;
  /** The clip the master picture came from, so a boundary is findable. */
  clipId: string | null;
  /**
   * Whether the frame drawn is the one that belongs at `t`.
   *
   * This is the measure that matters, and it is not the same as "a new
   * picture". Thirty-frame footage on a sixty-hertz display repeats every
   * source frame once and is perfectly smooth; a decoder that fell behind
   * repeats one too, and is not. Asking whether the source actually held the
   * wanted frame tells those apart.
   */
  exact: boolean;
  /** True when no decoded frame existed at all and the paint fell back to
   * holding or to black. A stale present never resolves a scrub. */
  stale: boolean;
}

/** A time the editor was asked to show, and when it was asked for. */
export interface SeekRecord {
  t: number;
  at: number;
  /** How long until a frame for this time was painted. Null while unresolved —
   * either still pending, or superseded by a later seek. */
  latencyMs: number | null;
}

export interface LongTaskRecord {
  at: number;
  ms: number;
}

export interface Trace {
  presents: PresentRecord[];
  seeks: SeekRecord[];
  longTasks: LongTaskRecord[];
  /** rAF callbacks the engine ran, for checking that an idle editor is idle. */
  ticks: number;
  /** Decoded frames the sources are holding open, sampled per present. */
  liveSamples: number[];
  /** Decoders open, sampled per present. Stood-down sources hold none, so this
   * is what the pool's budget is measured against. */
  liveSources: number[];
  /** Sources the pool holds at all, decoder or not, sampled per present. */
  keptSources: number[];
  /** Megabytes of canvas backing on the warm shelf — the stood-down sources,
   * which is the part the pool's memory budget governs. */
  warmMb: number[];
  /**
   * Seconds the picture is held behind the graph's clock, and seconds the
   * output device says it holds, sampled per present.
   *
   * A rendered sample has not been heard yet — it is in the buffer the device
   * reads next — so the moment the picture belongs at is the rendered moment
   * less that buffer. These two are read independently, one from the clock the
   * preview actually uses and one from the device, and they should agree. A
   * lead of zero against a device reporting otherwise is the picture running
   * ahead of its own sound by however much the device holds, which is tens of
   * milliseconds on CoreAudio and can be a fifth of a second on shared-mode
   * WASAPI or a Bluetooth output.
   */
  audioLead: number[];
  audioLatency: number[];
  startedAt: number;
}

/**
 * Records one trace keeps of each kind.
 *
 * The eval's runs are a fraction of this. What it bounds is a recording left
 * armed on a real machine: at sixty frames a second this is around twenty
 * minutes, after which the oldest records fall off and the trace describes the
 * most recent stretch — which is the stretch someone recording a stutter cares
 * about.
 */
const CAP = 72_000;

function keep<T>(xs: T[], x: T): void {
  xs.push(x);
  if (xs.length > CAP) xs.shift();
}

/** Times equal within this are the same instant. Half a frame at 120fps —
 * tight enough that a real lag never passes, loose enough that float drift on
 * the timeline never fails. */
const SAME_TIME = 0.004;

let trace: Trace | null = null;
let observer: PerformanceObserver | null = null;
/** The seek still waiting for its picture. A later seek replaces it, which is
 * what makes a fast drag measure the position it settled on. */
let pendingSeek: SeekRecord | null = null;

/** Whether anything is listening. The engine's hot path checks this first. */
export const tracing = () => trace !== null;

export function startTrace(): void {
  trace = {
    presents: [],
    seeks: [],
    longTasks: [],
    ticks: 0,
    liveSamples: [],
    liveSources: [],
    keptSources: [],
    warmMb: [],
    audioLead: [],
    audioLatency: [],
    startedAt: performance.now(),
  };
  pendingSeek = null;
  if (typeof PerformanceObserver === "undefined") return;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (trace) keep(trace.longTasks, { at: entry.startTime, ms: entry.duration });
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch {
    // Long-task timing is Chromium-only. Its absence costs one metric, not the
    // run.
    observer = null;
  }
}

export function stopTrace(): Trace | null {
  const out = trace;
  observer?.disconnect();
  observer = null;
  trace = null;
  pendingSeek = null;
  return out;
}

/** A time was asked for — a scrub, a skim, a click on the ruler. */
export function markSeek(t: number): void {
  if (!trace) return;
  const rec: SeekRecord = { t, at: performance.now(), latencyMs: null };
  keep(trace.seeks, rec);
  pendingSeek = rec;
}

/** A frame reached the canvas. */
export function markPresent(rec: Omit<PresentRecord, "at">): void {
  if (!trace) return;
  const at = performance.now();
  keep(trace.presents, { ...rec, at });
  // A held or black frame is not an answer to the question the scrub asked —
  // neither is the neighbouring frame drawn while the real one decodes. The
  // clock keeps running until the frame that belongs at that time is on screen.
  if (pendingSeek && rec.exact && !rec.stale && Math.abs(rec.t - pendingSeek.t) <= SAME_TIME) {
    pendingSeek.latencyMs = at - pendingSeek.at;
    pendingSeek = null;
  }
}

/** Whether a time has been asked for that no frame has answered yet. Lets a
 * driver wait for the picture to catch up instead of guessing at a delay. */
export const awaitingFrame = () => pendingSeek !== null;

/** One turn of the engine's loop. */
export function markTick(): void {
  if (!trace) return;
  trace.ticks++;
}

/** What the preview's clock is doing about the output device: how far the
 * picture is being held back, and how far the device says it should be. */
export function markAudioClock(lead: number, reported: number): void {
  if (!trace) return;
  keep(trace.audioLead, lead);
  keep(trace.audioLatency, reported);
}

/** How many decoded frames are being held open right now. */
export function markLiveSamples(n: number): void {
  if (!trace) return;
  keep(trace.liveSamples, n);
}

/** What the decoder pool is holding right now: sources with a decoder, sources
 * kept at all, and the canvas backing behind them. */
export function markLiveSources(active: number, kept: number, warmPixels: number): void {
  if (!trace) return;
  keep(trace.liveSources, active);
  keep(trace.keptSources, kept);
  keep(trace.warmMb, Math.round(warmPixels * 4e-6));
}

/** A trace boiled down to the numbers that name a stutter. */
export interface TraceReport {
  /** Seconds the recording covers, and frames painted in them. */
  seconds: number;
  presented: number;
  /** Frames a second the preview actually held. */
  fps: number;
  /** Share of frames that were not the one belonging at that moment: the
   * stutter, as the viewer sees it. */
  late: number;
  /** The same share over the first and last third, so a preview that decays
   * across a session is tellable from one that was always this way. */
  decay: { first: number; last: number };
  /** Seconds the picture sat behind the moment asked for. */
  lagP50: number;
  lagP95: number;
  lagMax: number;
  /** Seconds the picture is held back for the output device, and what the
   * device says it holds. These agree when the preview is reading the clock
   * its sound leaves on; a lead of zero against a device holding a fifth of a
   * second is a picture running that far ahead of its own audio. */
  audioLeadS: number;
  audioLatencyS: number;
  /** Decoders open, frames held, and the canvas backing behind them. */
  sources: number;
  held: number;
  warmMb: number;
  /** The longest the main thread was blocked, in milliseconds. */
  longTaskMs: number;
}

const pct = (xs: PresentRecord[]): number =>
  xs.length ? +(xs.filter((p) => !p.exact || p.stale).length / xs.length).toFixed(3) : 0;

const at = (xs: number[], q: number): number => {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))].toFixed(3);
};

/** Boil a trace down to something a person can paste into a bug report. */
export function traceReport(t: Trace): TraceReport {
  const presents = t.presents;
  const span = presents.length ? (presents[presents.length - 1].at - presents[0].at) / 1000 : 0;
  const lags = presents
    .filter((p) => p.srcTs !== null && p.wantSrc !== null)
    .map((p) => Math.max(0, p.wantSrc! - p.srcTs!));
  const third = Math.floor(presents.length / 3);
  return {
    seconds: +span.toFixed(1),
    presented: presents.length,
    fps: span > 0 ? +(presents.length / span).toFixed(1) : 0,
    late: pct(presents),
    decay: { first: pct(presents.slice(0, third)), last: pct(presents.slice(-third)) },
    lagP50: at(lags, 0.5),
    lagP95: at(lags, 0.95),
    lagMax: +Math.max(0, ...lags).toFixed(3),
    audioLeadS: at(t.audioLead, 0.5),
    audioLatencyS: at(t.audioLatency, 0.5),
    sources: Math.max(0, ...t.liveSources),
    held: Math.max(0, ...t.liveSamples),
    warmMb: Math.max(0, ...t.warmMb),
    longTaskMs: Math.round(Math.max(0, ...t.longTasks.map((l) => l.ms))),
  };
}
