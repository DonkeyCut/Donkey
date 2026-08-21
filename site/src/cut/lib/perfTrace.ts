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
 * is a null check. The eval arms it through `window.__cutPerf`; nothing in the
 * product turns it on.
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
   * With `srcTs` this is the whole sync story: sound is scheduled against the
   * same clock `t` comes from, so `wantSrc - srcTs` is how far the picture sits
   * behind the sound at that instant.
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
  startedAt: number;
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
    startedAt: performance.now(),
  };
  pendingSeek = null;
  if (typeof PerformanceObserver === "undefined") return;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        trace?.longTasks.push({ at: entry.startTime, ms: entry.duration });
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
  trace.seeks.push(rec);
  pendingSeek = rec;
}

/** A frame reached the canvas. */
export function markPresent(rec: Omit<PresentRecord, "at">): void {
  if (!trace) return;
  const at = performance.now();
  trace.presents.push({ ...rec, at });
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

/** How many decoded frames are being held open right now. */
export function markLiveSamples(n: number): void {
  if (!trace) return;
  trace.liveSamples.push(n);
}

/** What the decoder pool is holding right now: sources with a decoder, sources
 * kept at all, and the canvas backing behind them. */
export function markLiveSources(active: number, kept: number, warmPixels: number): void {
  if (!trace) return;
  trace.liveSources.push(active);
  trace.keptSources.push(kept);
  trace.warmMb.push(Math.round(warmPixels * 4e-6));
}
