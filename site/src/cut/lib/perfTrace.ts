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
const SAMPLE_CAP = 40;
/** A frame this far behind is a hitch a person would name. */
const HITCH_S = 0.25;

interface Meter {
  frames: number;
  late: number;
  stale: number;
  hitches: number;
  lagSum: number;
  lagMax: number;
  audioLead: number;
  audioLatency: number;
  sources: number;
  held: number;
  warmMb: number;
  longTaskMs: number;
  longTasks: number;
  clips: number;
  decodeHeight: number;
  canvasHeight: number;
  startedAt: number;
}

let meter: Meter | null = null;
let sink: ((sample: PerfSample) => void) | null = null;
let meterObserver: PerformanceObserver | null = null;
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
  audioLead: 0,
  audioLatency: 0,
  sources: 0,
  held: 0,
  warmMb: 0,
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
  if (typeof PerformanceObserver === "undefined") return;
  try {
    meterObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!meter) return;
        meter.longTasks++;
        meter.longTaskMs = Math.max(meter.longTaskMs, Math.round(entry.duration));
      }
    });
    meterObserver.observe({ entryTypes: ["longtask"] });
  } catch {
    meterObserver = null;
  }
}

/** Stop counting and forget the sink. */
export function stopMeter(): void {
  meterObserver?.disconnect();
  meterObserver = null;
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
}

/** What the preview's clock is doing about the output device. */
export function meterAudioClock(lead: number, reported: number): void {
  if (!meter) return;
  meter.audioLead = Math.max(meter.audioLead, lead);
  meter.audioLatency = Math.max(meter.audioLatency, reported);
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
  if (m.frames < SAMPLE_MIN_FRAMES || sampleCount >= SAMPLE_CAP) return;
  const seconds = (performance.now() - m.startedAt) / 1000;
  const round = (n: number, places = 3) => +n.toFixed(places);
  sink({
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
    sources: m.sources,
    heldFrames: m.held,
    warmMb: m.warmMb,
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
