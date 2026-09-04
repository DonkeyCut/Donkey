"use client";

import {
  heapBytes,
  mb,
  memoryCeiling,
  memoryUsage,
  takeMemoryPressure,
  type MemoryBucket,
  type MemoryUsage,
} from "./memoryBudget";
import { logPerfRecord, notePerfTrouble, perfUploadReason, type PerfUploadReason } from "./perfLog";
import { isTextEntry } from "./shortcutGate";

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
  /** Engine ticks that had run when the time was asked for. The first tick
   * after it is the first chance to paint the answer. */
  tick: number;
  /** How long until a frame for this time was painted. Null while unresolved —
   * either still pending, or superseded by a later seek. */
  latencyMs: number | null;
  /**
   * Frames the answer missed: zero when the first paint after the ask showed
   * it, one when it took the next.
   *
   * This is the measure a drag is judged on. The milliseconds above also
   * count the wait for the next frame, and that wait is the display's — half
   * a frame on average, eight milliseconds at a hundred and twenty hertz and
   * sixteen at sixty — so the same engine reads twice as slow on one monitor
   * as on another. Frames missed reads the same on both.
   */
  lateFrames: number | null;
}

export interface LongTaskRecord {
  at: number;
  ms: number;
}

/** A frame the browser reported as long, with the script it blames. */
export interface LongFrameRecord {
  at: number;
  ms: number;
  /** Of that, the part no other work could run in. */
  blockedMs: number;
  fn: string;
  src: string;
  invoker: string;
  scriptMs: number;
}

export interface Trace {
  presents: PresentRecord[];
  seeks: SeekRecord[];
  longTasks: LongTaskRecord[];
  /** The same stretches seen as frames, naming what held them. A long frame
   * spans the task, the style pass, the layout and the paint, so its length
   * is a different number from the task's and is read beside it. */
  longFrames: LongFrameRecord[];
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
  /** Megabytes the whole editor is modeled to hold, sampled per present:
   * decoders, canvases, the bytes behind them, sound and pictures. */
  memMb: number[];
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
let frameObserver: PerformanceObserver | null = null;
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
    longFrames: [],
    ticks: 0,
    liveSamples: [],
    liveSources: [],
    keptSources: [],
    warmMb: [],
    memMb: [],
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
  // Beside it, the same stretches as frames. A long task says a frame was
  // held; a long animation frame says which script held it, which is the
  // question a report leads to. They are kept apart because their lengths
  // mean different things and the budgets are set against the task's.
  try {
    frameObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!trace) continue;
        const lead = leadScript(entry as LongFrameEntry);
        keep(trace.longFrames, {
          at: entry.startTime,
          ms: entry.duration,
          blockedMs: Math.round((entry as LongFrameEntry).blockingDuration ?? 0),
          fn: lead?.sourceFunctionName ?? "",
          src: chunkName(lead?.sourceURL),
          invoker: lead?.invoker ?? "",
          scriptMs: Math.round(lead?.duration ?? 0),
        });
      }
    });
    frameObserver.observe({ type: "long-animation-frame", buffered: false });
  } catch {
    // Long animation frames are newer than long tasks; a browser without them
    // still reports the task.
    frameObserver = null;
  }
}

export function stopTrace(): Trace | null {
  const out = trace;
  observer?.disconnect();
  observer = null;
  frameObserver?.disconnect();
  frameObserver = null;
  trace = null;
  pendingSeek = null;
  return out;
}

/** A time was asked for — a scrub, a skim, a click on the ruler. */
export function markSeek(t: number): void {
  if (!trace) return;
  const rec: SeekRecord = { t, at: performance.now(), tick: trace.ticks, latencyMs: null, lateFrames: null };
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
    // A present runs inside a tick, after the tick has counted itself; the
    // first tick after the ask is the one that could have answered it.
    pendingSeek.lateFrames = Math.max(0, trace.ticks - pendingSeek.tick - 1);
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
  // Reading the total walks every cache that reports one, and this runs on
  // every present. Sampled on the meter's cadence, for the meter's reason: a
  // trace is what the perf eval judges, and a measurement that costs a frame
  // has changed the thing it was measuring.
  if (++traceMemTick % MEM_EVERY === 0) keep(trace.memMb, mb(memoryUsage().total));
}

let traceMemTick = 0;

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
  /** The most the editor was modeled to be holding, in megabytes, across every
   * cache that reports one. */
  memMb: number;
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

/** The largest of a series, walked rather than spread: these arrays run to
 * CAP, which is far more arguments than a call frame takes. */
const maxOf = (xs: number[]): number => {
  let m = 0;
  for (const x of xs) if (x > m) m = x;
  return m;
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
    lagMax: +maxOf(lags).toFixed(3),
    audioLeadS: at(t.audioLead, 0.5),
    audioLatencyS: at(t.audioLatency, 0.5),
    sources: maxOf(t.liveSources),
    held: maxOf(t.liveSamples),
    warmMb: maxOf(t.warmMb),
    memMb: maxOf(t.memMb),
    longTaskMs: Math.round(maxOf(t.longTasks.map((l) => l.ms))),
  };
}

/**
 * The preview's own report card, for the machines we cannot reproduce.
 *
 * The trace above answers a question asked in a lab: a script drives the
 * editor, reads every frame back, and holds the run to a budget. This answers
 * the same question about someone's own machine, where nobody is driving and
 * nothing can be read back — an integrated GPU with no video overlay support,
 * a Windows audio buffer several times the size of CoreAudio's, a codec the
 * hardware decoder does not take. Those preview badly in ways that are
 * invisible here, and a driver dump only narrows the guess.
 *
 * So the meter counts what the trace measures, in fixed memory: a handful of
 * running totals per played frame, flushed as one summary every half minute of
 * playback. It is off unless the account turned it on, and while it is off the
 * cost on the engine's hot path is a null check.
 *
 * Nothing here reads the project. No frame, no sound, no clip name, no file
 * name — the numbers are timings, sizes and counts of what the machine did.
 */

/** What the decoders on this machine can do in hardware. Probed once, because
 * a stutter on footage the hardware refuses is a different bug from a stutter
 * on footage it takes. */
export interface DecodeCaps {
  h264: boolean;
  hevc: boolean;
  vp9: boolean;
  av1: boolean;
}

export interface PerfSample {
  /** Why this session is sending — see perfLog. */
  reason: PerfUploadReason;
  /** Which summary this is in the session, and how long the editor had been
   * open when it closed — a preview that is smooth for a minute and choppy
   * after ten is two samples that say so. */
  sample: number;
  openedForS: number;
  /** Playback this summary covers. */
  seconds: number;
  frames: number;
  fps: number;
  /** Share of frames that were not the picture belonging at that moment: the
   * stutter, as the viewer sees it. */
  lateShare: number;
  /** Share with no decoded picture at all — the preview holding a frame. */
  staleShare: number;
  /** Share more than a quarter second behind: the hitches a viewer calls out. */
  hitchShare: number;
  /** Seconds the picture sat behind the moment asked for. */
  lagMeanS: number;
  lagMaxS: number;
  /** Seconds the picture is held back for the output device, and what the
   * device says it holds. These agree when the preview is reading the clock
   * its sound leaves on; a lead of zero against a device holding a fifth of a
   * second is a picture running that far ahead of its own audio. */
  audioLeadS: number;
  audioLatencyS: number;
  /**
   * Sound that missed its moment: windows the mixer had to start late, and
   * the worst by how much; and the times the clock re-anchored because the
   * audio graph fell away from the wall — an output that dropped out, a
   * device that stalled under load. A picture that keeps time while these
   * climb is the "audio cuts out" that no frame count shows.
   */
  audioLate: number;
  audioLateMaxS: number;
  clockJumps: number;
  /**
   * Walks the preview started while playing, and the worst one's cost.
   *
   * A walk is a decoder reading forward from a keyframe, and holding on to one
   * is what makes playback cheap. A window that started dozens of them is a
   * reader that could not hold on to any — the picture then sits on whatever
   * frame it last had while the sound runs on, which is the shape every report
   * of choppy playback has turned out to be.
   */
  walks: number;
  walkMs: number;
  /**
   * The worst and the average wait for one frame off a walk, in milliseconds.
   *
   * This is the number that says which kind of starvation it was. A decoder
   * that is merely slow answers every pull in tens of milliseconds and falls
   * behind gradually; a reader whose bytes have not arrived waits seconds on
   * one pull and nothing at all on the next. From the outside the two look
   * identical, and the fix for them is not the same.
   */
  pullMaxMs: number;
  pullMeanMs: number;
  /** The file behind the picture: what it really is, which `decodeHeight` —
   * the height the preview asked for — cannot say. A frame rate above thirty
   * halves what a fixed lookahead buys, and a size far above the stage says
   * the decode is paying for pixels nothing shows. */
  srcW: number;
  srcH: number;
  srcFps: number;
  srcCodec: string;
  /** What the preview was holding open at its peak. */
  sources: number;
  heldFrames: number;
  warmMb: number;
  /** Main thread blocked: the worst one, and how many there were. */
  longTaskMs: number;
  longTasks: number;
  /** The shape of the cut and the size of the picture, since both decide how
   * much work a frame is. */
  clips: number;
  decodeHeight: number;
  canvasHeight: number;
  dpr: number;
  /**
   * The worst the memory got during the window, modeled in megabytes: the
   * total, where it went, and what this machine allows. A preview that
   * stutters against a total sitting on its ceiling is a different fault from
   * one that stutters with room to spare, and only the pair says which.
   */
  memMb: number;
  memCeilingMb: number;
  decoderMb: number;
  canvasMb: number;
  readMb: number;
  audioMb: number;
  pictureMb: number;
  /** The JavaScript heap at its worst, where the browser reports one. */
  heapMb: number;
  /** Buckets the ceiling sized: the machine is what is holding them down. */
  memBound: string;
  /** What the machine brought. */
  cores: number;
  memoryGb: number;
  hwH264: boolean;
  hwHevc: boolean;
  hwVp9: boolean;
  hwAv1: boolean;
}

/** Playback frames in one summary: about half a minute at sixty a second. */
const SAMPLE_FRAMES = 1800;
/** Fewest frames worth reporting when a play ends early. */
const SAMPLE_MIN_FRAMES = 240;
/** Summaries one editor session will send. A day-long session is interesting
 * for its first few, and this is not a firehose. */
const SAMPLE_CAP = 8;
/** A frame this far behind is a hitch a person would name. */
const HITCH_S = 0.25;
/** A play with this share of hitches, or a picture this far behind its sound,
 * is trouble the session sends about — see perfLog for what that starts. */
const TROUBLE_HITCH_SHARE = 0.2;
const TROUBLE_LAG_S = 1;
/** Sound starting late this many times in one window, or the clock
 * re-anchoring this many, is trouble too. */
const TROUBLE_AUDIO_LATE = 3;
const TROUBLE_CLOCK_JUMPS = 2;

interface Meter {
  frames: number;
  late: number;
  stale: number;
  hitches: number;
  lagSum: number;
  lagMax: number;
  walks: number;
  walkMs: number;
  pullMax: number;
  pullSum: number;
  pulls: number;
  srcW: number;
  srcH: number;
  srcFps: number;
  srcCodec: string;
  audioLead: number;
  audioLatency: number;
  audioLate: number;
  audioLateMax: number;
  clockJumps: number;
  sources: number;
  held: number;
  warmMb: number;
  memBytes: number;
  usage: MemoryUsage;
  heapBytes: number;
  bound: Set<MemoryBucket>;
  longTaskMs: number;
  longTasks: number;
  clips: number;
  decodeHeight: number;
  canvasHeight: number;
  startedAt: number;
}

let meter: Meter | null = null;
let sink: ((sample: PerfSample) => void) | null = null;
let sampleCount = 0;
let openedAt = 0;
let caps: DecodeCaps = { h264: false, hevc: false, vp9: false, av1: false };

const emptyMeter = (): Meter => ({
  frames: 0,
  late: 0,
  stale: 0,
  hitches: 0,
  lagSum: 0,
  lagMax: 0,
  walks: 0,
  walkMs: 0,
  pullMax: 0,
  pullSum: 0,
  pulls: 0,
  srcW: 0,
  srcH: 0,
  srcFps: 0,
  srcCodec: "",
  audioLead: 0,
  audioLatency: 0,
  audioLate: 0,
  audioLateMax: 0,
  clockJumps: 0,
  sources: 0,
  held: 0,
  warmMb: 0,
  memBytes: 0,
  usage: { decoders: 0, canvases: 0, reads: 0, audio: 0, pictures: 0, total: 0 },
  heapBytes: 0,
  bound: new Set(),
  longTaskMs: 0,
  longTasks: 0,
  clips: 0,
  decodeHeight: 0,
  canvasHeight: 0,
  startedAt: performance.now(),
});

/** Whether anything is counting. The engine's hot path checks this first. */
export const metering = (): boolean => meter !== null;

/**
 * Start counting, and send each summary to `report`.
 *
 * Calling again replaces the sink and leaves the counts alone, so a flag read
 * that resolves twice does not restart the session's numbering.
 */
export function meterPerf(report: (sample: PerfSample) => void): void {
  sink = report;
  if (meter) return;
  openedAt = performance.now();
  meter = emptyMeter();
  void probeDecodeCaps();
}

/** Stop counting and forget the sink. */
export function stopMeter(): void {
  meter = null;
  sink = null;
}

/** One played frame: how far behind the moment asked for the picture was, and
 * whether there was a decoded picture for it at all. */
export function meterFrame(lagS: number, stale: boolean): void {
  if (!meter) return;
  meter.frames++;
  if (stale) meter.stale++;
  if (stale || lagS > SAME_TIME) meter.late++;
  if (lagS > HITCH_S) meter.hitches++;
  meter.lagSum += lagS;
  meter.lagMax = Math.max(meter.lagMax, lagS);
  if (meter.frames >= SAMPLE_FRAMES) flushMeter();
}

/** What the preview is holding open, and the size it is working at. */
export function meterState(state: {
  sources: number;
  held: number;
  warmMb: number;
  clips: number;
  decodeHeight: number;
  canvasHeight: number;
}): void {
  if (!meter) return;
  meter.sources = Math.max(meter.sources, state.sources);
  meter.held = Math.max(meter.held, state.held);
  meter.warmMb = Math.max(meter.warmMb, state.warmMb);
  meter.clips = Math.max(meter.clips, state.clips);
  meter.decodeHeight = state.decodeHeight;
  meter.canvasHeight = state.canvasHeight;
  // Every caller of this is on the frame path, and reading the memory total
  // walks every cache that reports one. Twice a second is often enough to
  // catch a peak that lasts long enough to matter and rare enough that the
  // walk never shows up in a frame.
  if (++memTick % MEM_EVERY) return;
  for (const b of takeMemoryPressure()) meter.bound.add(b);
  const usage = memoryUsage();
  if (usage.total > meter.memBytes) {
    meter.memBytes = usage.total;
    meter.usage = usage;
  }
  meter.heapBytes = Math.max(meter.heapBytes, heapBytes());
}

/** Frames between memory reads — see `meterState`. */
const MEM_EVERY = 30;
let memTick = 0;

/** A walk was anchored, and — once it lands — what reaching its first frame
 * cost. Counted only while playing, since a scrub anchors walks by design. */
export function meterWalk(costMs?: number): void {
  if (!meter) return;
  if (costMs === undefined) meter.walks++;
  else meter.walkMs = Math.max(meter.walkMs, Math.round(costMs));
}

/** How long one pull waited for its frame. */
export function meterPull(ms: number): void {
  if (!meter) return;
  meter.pulls++;
  meter.pullSum += ms;
  meter.pullMax = Math.max(meter.pullMax, ms);
}

/** The shape of the file a landed frame came from. */
export function meterSource(
  width: number,
  height: number,
  fps: number,
  codec: string
): void {
  if (!meter || !(fps > 0)) return;
  meter.srcW = Math.max(meter.srcW, Math.round(width));
  meter.srcH = Math.max(meter.srcH, Math.round(height));
  meter.srcFps = Math.max(meter.srcFps, Math.round(fps));
  // A machine that decodes H.264 in hardware and refuses AV1 runs the same
  // preview two entirely different ways, and the size and rate of the file
  // cannot tell those apart. This is the field that does.
  if (codec) meter.srcCodec = codec;
}

/** What the preview's clock is doing about the output device. */
export function meterAudioClock(lead: number, reported: number): void {
  if (!meter) return;
  meter.audioLead = Math.max(meter.audioLead, lead);
  meter.audioLatency = Math.max(meter.audioLatency, reported);
}

/** A window of sound started after the moment it was for, by `lateS`. */
export function meterAudioLate(lateS: number): void {
  if (!meter) return;
  meter.audioLate++;
  meter.audioLateMax = Math.max(meter.audioLateMax, lateS);
}

/** The mixer re-anchored its clock: the audio graph had fallen away from the
 * wall, and everything scheduled was torn down and refilled. */
export function meterClockJump(): void {
  if (!meter) return;
  meter.clockJumps++;
}

/**
 * Send what has been counted and start a fresh count.
 *
 * A play that ends before the window fills still reports, because a short play
 * that stuttered is the whole complaint; a handful of frames is noise and is
 * dropped instead.
 */
export function flushMeter(): void {
  const m = meter;
  if (!m || !sink) return;
  meter = emptyMeter();
  // Trouble is read before the window is judged too short to report. A play
  // that froze draws few frames — the thread was blocked — so the shortest
  // windows are the ones carrying the worst news.
  if (
    (m.frames > 0 && m.hitches / m.frames >= TROUBLE_HITCH_SHARE) ||
    m.lagMax >= TROUBLE_LAG_S ||
    m.audioLate >= TROUBLE_AUDIO_LATE ||
    m.clockJumps >= TROUBLE_CLOCK_JUMPS
  )
    notePerfTrouble();
  if (m.frames < SAMPLE_MIN_FRAMES) return;
  const reason = perfUploadReason();
  if (!reason || sampleCount >= SAMPLE_CAP) return;
  const seconds = (performance.now() - m.startedAt) / 1000;
  const round = (n: number, places = 3) => +n.toFixed(places);
  sink({
    reason,
    sample: ++sampleCount,
    openedForS: Math.round((performance.now() - openedAt) / 1000),
    seconds: round(seconds, 1),
    frames: m.frames,
    fps: seconds > 0 ? round(m.frames / seconds, 1) : 0,
    lateShare: round(m.late / m.frames),
    staleShare: round(m.stale / m.frames),
    hitchShare: round(m.hitches / m.frames),
    lagMeanS: round(m.lagSum / m.frames),
    lagMaxS: round(m.lagMax),
    audioLeadS: round(m.audioLead),
    audioLatencyS: round(m.audioLatency),
    audioLate: m.audioLate,
    audioLateMaxS: round(m.audioLateMax),
    clockJumps: m.clockJumps,
    walks: m.walks,
    walkMs: m.walkMs,
    pullMaxMs: Math.round(m.pullMax),
    pullMeanMs: m.pulls ? Math.round(m.pullSum / m.pulls) : 0,
    srcW: m.srcW,
    srcH: m.srcH,
    srcFps: m.srcFps,
    srcCodec: m.srcCodec,
    sources: m.sources,
    heldFrames: m.held,
    warmMb: m.warmMb,
    memMb: mb(m.memBytes),
    memCeilingMb: mb(memoryCeiling()),
    decoderMb: mb(m.usage.decoders),
    canvasMb: mb(m.usage.canvases),
    readMb: mb(m.usage.reads),
    audioMb: mb(m.usage.audio),
    pictureMb: mb(m.usage.pictures),
    heapMb: mb(m.heapBytes),
    memBound: [...m.bound].join(","),
    longTaskMs: m.longTaskMs,
    longTasks: m.longTasks,
    clips: m.clips,
    decodeHeight: m.decodeHeight,
    canvasHeight: m.canvasHeight,
    dpr: typeof devicePixelRatio === "number" ? round(devicePixelRatio, 2) : 1,
    cores: navigator.hardwareConcurrency || 0,
    memoryGb: (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 0,
    hwH264: caps.h264,
    hwHevc: caps.hevc,
    hwVp9: caps.vp9,
    hwAv1: caps.av1,
  });
}

/**
 * Which codecs this machine decodes in hardware, at 1080p.
 *
 * The answer separates two very different stutters. A machine that takes the
 * footage in hardware and still drops frames is spending its time somewhere
 * after the decoder — converting frames, uploading them, compositing. A
 * machine whose decoder refuses the codec is running every stream on the CPU,
 * where a fast cut has no chance. Both look identical from the outside.
 */
async function probeDecodeCaps(): Promise<void> {
  if (typeof VideoDecoder === "undefined") return;
  const ask = async (codec: string): Promise<boolean> => {
    try {
      const support = await VideoDecoder.isConfigSupported({
        codec,
        codedWidth: 1920,
        codedHeight: 1080,
        hardwareAcceleration: "prefer-hardware",
      });
      return support.supported === true;
    } catch {
      return false;
    }
  };
  const [h264, hevc, vp9, av1] = await Promise.all([
    ask("avc1.640028"),
    ask("hvc1.1.6.L120.90"),
    ask("vp09.00.41.08"),
    ask("av01.0.09M.08"),
  ]);
  caps = { h264, hevc, vp9, av1 };
}

/**
 * The main thread's report card, for the freezes that happen between plays.
 *
 * The meter above counts what the preview did per played frame, so it says
 * nothing about a delete that took two seconds to land or an import that
 * froze the page. This watches the thread itself: every animation frame the
 * browser reports as long, with the script that ran it and what it was
 * invoked by — the one attribution a person's own machine can give, since the
 * profiler is never open when it happens.
 *
 * Long animation frames are Chromium's. Where the API is missing the long
 * task list stands in, which names the cost and nothing about its cause.
 *
 * Nothing here reads the project. The script names are the page's own
 * bundle; the "input" beside a frame is which control was pressed — a button's
 * label, a key's name — and a key pressed into a text field is reported as
 * text, never as the character.
 */
export interface MainThreadSample {
  /** Why this session is sending — see perfLog. */
  reason: PerfUploadReason;
  sample: number;
  openedForS: number;
  /** Wall seconds this summary covers. */
  seconds: number;
  /** Frames the thread was blocked in, milliseconds blocked across them, and
   * the longest of them. */
  longFrames: number;
  blockedMs: number;
  worstMs: number;
  /** The worst frame: how it split between script and layout, what invoked
   * the script, and where in the bundle it lives. */
  worstScriptMs: number;
  worstLayoutMs: number;
  worstInvoker: string;
  worstFn: string;
  worstSrc: string;
  worstChar: number;
  /** What the editor was doing when the worst frame hit, and what was pressed
   * last, how long before. */
  worstActivity: MainThreadActivity;
  worstInput: string;
  worstInputAgoMs: number;
  /** The three scripts that blocked longest across the window, as
   * "invoker>function:ms", pipe-separated. */
  top: string;
  /** The size of the cut at flush time. */
  clips: number;
  audioClips: number;
  overlays: number;
  assets: number;
  cores: number;
  memoryGb: number;
}

export type MainThreadActivity = "playing" | "dragging" | "idle";

/** What the editor tells the meter about itself when a frame lands. */
export interface MainThreadContext {
  activity: MainThreadActivity;
  clips: number;
  audioClips: number;
  overlays: number;
  assets: number;
}

/** A long-animation-frame entry, as Chromium reports it. The lib has no
 * type for it yet. */
interface LongFrameEntry extends PerformanceEntry {
  blockingDuration?: number;
  renderStart?: number;
  styleAndLayoutStart?: number;
  scripts?: LongFrameScript[];
}

interface LongFrameScript {
  duration: number;
  invoker?: string;
  sourceURL?: string;
  sourceFunctionName?: string;
  sourceCharPosition?: number;
}

interface WorstFrame {
  ms: number;
  scriptMs: number;
  layoutMs: number;
  invoker: string;
  fn: string;
  src: string;
  char: number;
  activity: MainThreadActivity;
  input: string;
  inputAgoMs: number;
}

interface ThreadMeter {
  longFrames: number;
  blockedMs: number;
  worst: WorstFrame | null;
  /** Blocked milliseconds per "invoker>function", for the top list. */
  byScript: Map<string, number>;
  startedAt: number;
}

/** A window this long is one summary. */
const THREAD_FLUSH_MS = 30_000;
/** A window whose worst frame is under this reports nothing, and a frame
 * under it is not kept in the log: a page that is merely busy is not the
 * complaint. */
const THREAD_REPORT_MS = 100;
/** Summaries one editor session will send. */
const THREAD_SAMPLE_CAP = 8;
/** A single frame this long, or a window blocked for this long in total, is
 * trouble the session sends about — see perfLog for what that starts. */
const TROUBLE_FRAME_MS = 1_000;
const TROUBLE_WINDOW_MS = 3_000;
/** An input older than this is not what a frame is answering. */
const INPUT_RECENT_MS = 5_000;

let threadMeter: ThreadMeter | null = null;
let threadSink: ((sample: MainThreadSample) => void) | null = null;
let threadContext: (() => MainThreadContext) | null = null;
let threadObserver: PerformanceObserver | null = null;
let threadTimer: ReturnType<typeof setInterval> | null = null;
let threadSamples = 0;
let threadOpenedAt = 0;
let lastInput: { at: number; what: string } | null = null;
let removeInputWatch: (() => void) | null = null;

const emptyThreadMeter = (): ThreadMeter => ({
  longFrames: 0,
  blockedMs: 0,
  worst: null,
  byScript: new Map(),
  startedAt: performance.now(),
});

/** The last path segment of a bundle URL — the chunk's name, which is what a
 * source map resolves against. */
const chunkName = (url: string | undefined): string => {
  if (!url) return "";
  const path = url.split(/[?#]/)[0];
  return path.slice(path.lastIndexOf("/") + 1);
};

/**
 * Which control an input landed on, read from the page's structure: a
 * timeline selection's kind, the component slots around it, the tag and an
 * input's type — every one of them a literal in this codebase.
 *
 * Nothing the page displays goes in. A label or a button's text carries what
 * the person named, wrote, or was shown — a file name, a project, another
 * user's email — and a performance record is no place for any of it.
 */
function describeTarget(target: EventTarget | null): string {
  const el = target instanceof Element ? target : null;
  if (!el) return "";
  const sel = el.closest<HTMLElement>("[data-tl-sel]");
  if (sel) return `timeline:${(sel.dataset.tlSel ?? "").split(":")[0]}`;
  const self = el instanceof HTMLInputElement ? `input:${el.type}` : el.tagName.toLowerCase();
  const slots: string[] = [];
  for (let node: Element | null = el; node && slots.length < 2; node = node.parentElement) {
    const slot = node instanceof HTMLElement ? node.dataset.slot : undefined;
    if (slot) slots.unshift(slot);
  }
  return slots.length ? `${slots.join(">")} ${self}` : self;
}

function watchInputs(): () => void {
  const onPointer = (e: PointerEvent) => {
    lastInput = { at: performance.now(), what: `press ${describeTarget(e.target)}` };
  };
  const onKey = (e: KeyboardEvent) => {
    const mods = [e.ctrlKey && "ctrl", e.metaKey && "cmd", e.altKey && "alt", e.shiftKey && "shift"]
      .filter(Boolean)
      .join("+");
    const key = isTextEntry(e.target) ? "text" : e.key.length === 1 ? e.key.toLowerCase() : e.key;
    lastInput = { at: performance.now(), what: `key ${mods ? `${mods}+` : ""}${key}` };
  };
  window.addEventListener("pointerdown", onPointer, true);
  window.addEventListener("keydown", onKey, true);
  return () => {
    window.removeEventListener("pointerdown", onPointer, true);
    window.removeEventListener("keydown", onKey, true);
  };
}

/** The script that held a frame the longest, of those the browser named. */
function leadScript(entry: LongFrameEntry): LongFrameScript | null {
  let lead: LongFrameScript | null = null;
  for (const s of entry.scripts ?? []) if (!lead || s.duration > lead.duration) lead = s;
  return lead;
}

function noteLongFrame(entry: LongFrameEntry): void {
  const m = threadMeter;
  if (!m) return;
  const ms = entry.duration;
  const blocked = entry.blockingDuration ?? Math.max(0, ms - 50);
  m.longFrames++;
  m.blockedMs += blocked;
  if (meter) {
    meter.longTasks++;
    meter.longTaskMs = Math.max(meter.longTaskMs, Math.round(ms));
  }
  const scripts = entry.scripts ?? [];
  let scriptMs = 0;
  const lead = leadScript(entry);
  for (const s of scripts) {
    scriptMs += s.duration;
    const fn = s.sourceFunctionName || chunkName(s.sourceURL);
    const key = `${s.invoker ?? ""}>${fn}`;
    m.byScript.set(key, (m.byScript.get(key) ?? 0) + s.duration);
  }
  const end = entry.startTime + ms;
  const layoutMs =
    entry.styleAndLayoutStart && entry.styleAndLayoutStart > 0 ? end - entry.styleAndLayoutStart : 0;
  if (ms < THREAD_REPORT_MS && m.worst) return;
  const at = performance.now();
  const recent = lastInput && at - lastInput.at <= INPUT_RECENT_MS + ms ? lastInput : null;
  const frame: WorstFrame = {
    ms,
    scriptMs,
    layoutMs,
    invoker: lead?.invoker ?? "",
    fn: lead?.sourceFunctionName ?? "",
    src: chunkName(lead?.sourceURL),
    char: lead?.sourceCharPosition ?? -1,
    activity: threadContext?.().activity ?? "idle",
    input: recent?.what ?? "",
    inputAgoMs: recent ? Math.max(0, Math.round(entry.startTime - recent.at)) : -1,
  };
  if (ms >= TROUBLE_FRAME_MS) notePerfTrouble();
  if (ms >= THREAD_REPORT_MS) {
    logPerfRecord({
      at: Math.round(performance.timeOrigin + entry.startTime),
      ms: Math.round(ms),
      blockedMs: Math.round(blocked),
      scriptMs: Math.round(scriptMs),
      layoutMs: Math.round(layoutMs),
      invoker: frame.invoker,
      fn: frame.fn,
      src: frame.src,
      char: frame.char,
      activity: frame.activity,
      input: frame.input,
      inputAgoMs: frame.inputAgoMs,
    });
  }
  if (!m.worst || ms > m.worst.ms) m.worst = frame;
}

/** Whether the main thread is being watched. */
export const meteringMainThread = (): boolean => threadMeter !== null;

/**
 * Start watching the main thread, sending each summary to `report` with what
 * `context` says the editor was doing. Calling again replaces both and leaves
 * the counts alone.
 */
export function meterMainThread(
  report: (sample: MainThreadSample) => void,
  context: () => MainThreadContext
): void {
  threadSink = report;
  threadContext = context;
  if (threadMeter) return;
  if (typeof PerformanceObserver === "undefined") return;
  const types = PerformanceObserver.supportedEntryTypes ?? [];
  const type = types.includes("long-animation-frame")
    ? "long-animation-frame"
    : types.includes("longtask")
      ? "longtask"
      : null;
  if (!type) return;
  threadOpenedAt = performance.now();
  threadMeter = emptyThreadMeter();
  try {
    threadObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) noteLongFrame(entry as LongFrameEntry);
    });
    threadObserver.observe({ type });
  } catch {
    threadObserver = null;
    threadMeter = null;
    return;
  }
  removeInputWatch = watchInputs();
  threadTimer = setInterval(flushMainThreadMeter, THREAD_FLUSH_MS);
}

/** Send what has been counted and start a fresh window. A window with no
 * frame worth naming sends nothing. */
export function flushMainThreadMeter(): void {
  const m = threadMeter;
  if (!m || !threadSink) return;
  threadMeter = emptyThreadMeter();
  // A window blocked for seconds is trouble however it got there: one long
  // frame, or a hundred medium ones that never reach the reporting bar.
  if (m.blockedMs >= TROUBLE_WINDOW_MS) notePerfTrouble();
  const worst = m.worst;
  if (!worst || worst.ms < THREAD_REPORT_MS) return;
  const reason = perfUploadReason();
  if (!reason || threadSamples >= THREAD_SAMPLE_CAP) return;
  const ctx = threadContext?.() ?? { activity: "idle", clips: 0, audioClips: 0, overlays: 0, assets: 0 };
  const top = [...m.byScript.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, ms]) => `${key}:${Math.round(ms)}`)
    .join(" | ");
  threadSink({
    reason,
    sample: ++threadSamples,
    openedForS: Math.round((performance.now() - threadOpenedAt) / 1000),
    seconds: +((performance.now() - m.startedAt) / 1000).toFixed(1),
    longFrames: m.longFrames,
    blockedMs: Math.round(m.blockedMs),
    worstMs: Math.round(worst.ms),
    worstScriptMs: Math.round(worst.scriptMs),
    worstLayoutMs: Math.round(worst.layoutMs),
    worstInvoker: worst.invoker,
    worstFn: worst.fn,
    worstSrc: worst.src,
    worstChar: worst.char,
    worstActivity: worst.activity,
    worstInput: worst.input,
    worstInputAgoMs: worst.inputAgoMs,
    top,
    clips: ctx.clips,
    audioClips: ctx.audioClips,
    overlays: ctx.overlays,
    assets: ctx.assets,
    cores: navigator.hardwareConcurrency || 0,
    memoryGb: (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 0,
  });
}

/** Stop watching, sending the window in hand first. */
export function stopMainThreadMeter(): void {
  flushMainThreadMeter();
  if (threadTimer) clearInterval(threadTimer);
  threadTimer = null;
  threadObserver?.disconnect();
  threadObserver = null;
  removeInputWatch?.();
  removeInputWatch = null;
  threadMeter = null;
  threadSink = null;
  threadContext = null;
  lastInput = null;
}
