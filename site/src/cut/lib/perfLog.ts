"use client";

/**
 * A durable record of the frames the main thread was blocked in.
 *
 * The meter in perfTrace boils a half minute down to one summary, which is
 * the shape a chart wants and the wrong shape for a bug report: "the delete
 * at 10:19 took 1.7 seconds inside X" is one frame, and it is gone from the
 * summary the moment a longer one lands. This keeps the frames themselves —
 * the last few hundred, in fixed memory — and gets them to PostHog when the
 * machine has nothing better to do.
 *
 * Nothing here runs on the hot path. A frame is an object pushed onto an
 * array. The array reaches localStorage at idle, at most once every ten
 * seconds and only when something was added, so a tab that crashes still
 * leaves its log behind.
 *
 * Every machine records. Few send: with ten thousand accounts, a log from
 * each would be a flood of pages that were fine. A session sends when it has
 * seen trouble — a frame over a second, a half minute mostly blocked, a play
 * that hitched or whose sound ran late — so the frames that led up to it
 * arrive with it, and a small random share of sessions send regardless,
 * which is the baseline the trouble is measured against.
 * Batches go out at idle, on the page hiding (the analytics client beacons
 * what it holds), and on the next open for whatever the last page never got
 * to send — a session that crashed reads as trouble on the page after it.
 *
 * Every record is timings, a script's name in the page's own bundle, and
 * which control was pressed — see perfTrace's meter for what is kept out.
 */

export interface PerfLogRecord {
  /** Monotonic across page loads on this machine, so a batch sent twice —
   * once by a beacon that did land, once by the next open that could not
   * know — reads as one. */
  id: number;
  /** Epoch milliseconds the frame started, and when the page it happened on
   * was opened, so frames group by page load after the fact. */
  at: number;
  open: number;
  ms: number;
  blockedMs: number;
  scriptMs: number;
  layoutMs: number;
  invoker: string;
  fn: string;
  src: string;
  char: number;
  activity: string;
  input: string;
  inputAgoMs: number;
}

export interface PerfLogBatch {
  /** Which batch of the drain this is, out of how many, and why this session
   * is sending at all. */
  batch: number;
  of: number;
  reason: PerfUploadReason;
  records: PerfLogRecord[];
  cores: number;
  memoryGb: number;
}

/** Why a session uploads: it drew the sample, or it saw trouble. */
export type PerfUploadReason = "sampled" | "trouble";

const KEY = "cut-perf-log";
const VERSION = 1;
/** Frames kept. At ~150 bytes each this is a write of tens of kilobytes,
 * which is what the machines this runs on can afford to spend on being
 * measured. */
const CAP = 250;
/** Frames older than this are dropped at open: a stall last week is not the
 * context for a stall today. */
const KEEP_MS = 24 * 60 * 60_000;
/** Records per batch sent. */
const BATCH = 40;
/** Storage writes and in-session drains wait at least this long apart. A
 * struggling machine produces long frames without pause, so this is the
 * cadence of the write, and the page hiding flushes whatever it holds. */
const WRITE_MIN_MS = 30_000;
const DRAIN_MIN_MS = 5 * 60_000;
/** A drain right after open waits this long, so the open itself is not what
 * it competes with; one that trouble asked for waits only long enough for
 * the frames around it to land. */
const DRAIN_AFTER_OPEN_MS = 20_000;
const DRAIN_AFTER_TROUBLE_MS = 5_000;
/** Share of sessions that send without having seen trouble. One in a
 * hundred is a few dozen baselines a day at the current size, which is
 * enough to draw a percentile against. */
const SAMPLE_RATE = 0.01;
/** Drains one session will send, and batches each may hold: at most ten
 * events of frames from one session, however long it ran. */
const DRAIN_CAP = 2;
const BATCH_CAP = 5;

interface Stored {
  v: number;
  /** Records in order; `id` is monotonic across page loads. */
  records: PerfLogRecord[];
  nextId: number;
  sentThrough: number;
  /** Epoch milliseconds a session last saw trouble it has not drained, so a
   * page that ended before its drain hands the reason to the next one. */
  troubleAt: number;
}

let state: Stored | null = null;
let sink: ((batch: PerfLogBatch) => void) | null = null;
let sampled = false;
let rolled = false;
let trouble = false;
let drains = 0;
let dirty = false;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let drainTimer: ReturnType<typeof setTimeout> | null = null;
let openedAt = 0;
let removePageHide: (() => void) | null = null;

const idle = (fn: () => void): void => {
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => fn(), { timeout: 5_000 });
  else setTimeout(fn, 0);
};

function load(): Stored {
  if (state) return state;
  let parsed: Stored | null = null;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) parsed = JSON.parse(raw) as Stored;
  } catch {
    parsed = null;
  }
  state =
    parsed && parsed.v === VERSION && Array.isArray(parsed.records)
      ? { ...parsed, troubleAt: parsed.troubleAt || 0 }
      : { v: VERSION, records: [], nextId: 1, sentThrough: 0, troubleAt: 0 };
  return state;
}

function persist(): void {
  if (!dirty || !state) return;
  dirty = false;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage full or unavailable; the records stay in memory and send from
    // there.
  }
}

function scheduleWrite(): void {
  dirty = true;
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    idle(persist);
  }, WRITE_MIN_MS);
}

/** Keep one frame. Cheap enough to call from a performance observer. */
export function logPerfRecord(rec: Omit<PerfLogRecord, "id" | "open">): void {
  if (typeof window === "undefined") return;
  const s = load();
  s.records.push({ ...rec, open: openedAt, id: s.nextId++ });
  if (s.records.length > CAP) s.records.splice(0, s.records.length - CAP);
  scheduleWrite();
}

/** Why this session sends, or null while it has no reason to. The meters
 * ask before every summary. */
export function perfUploadReason(): PerfUploadReason | null {
  if (trouble) return "trouble";
  if (sampled) return "sampled";
  return null;
}

/** The session has seen something worth sending: the log drains shortly,
 * carrying the frames that led here, and summaries send from now on. */
export function notePerfTrouble(): void {
  if (trouble) return;
  trouble = true;
  if (state) {
    state.troubleAt = Date.now();
    scheduleWrite();
  }
  if (sink) scheduleDrain(DRAIN_AFTER_TROUBLE_MS);
}

/** Send everything not yet sent, in batches, and remember how far that got.
 * Sends nothing while the session has no reason to, and after its share of
 * drains is spent. */
export function drainPerfLog(): void {
  const s = state;
  const reason = perfUploadReason();
  if (!s || !sink || !reason || drains >= DRAIN_CAP) return;
  const pending = s.records.filter((r) => r.id > s.sentThrough).slice(-BATCH * BATCH_CAP);
  if (pending.length === 0) return;
  drains++;
  const of = Math.ceil(pending.length / BATCH);
  const cores = navigator.hardwareConcurrency || 0;
  const memoryGb = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 0;
  for (let i = 0; i < of; i++) {
    sink({
      batch: i + 1,
      of,
      reason,
      records: pending.slice(i * BATCH, (i + 1) * BATCH),
      cores,
      memoryGb,
    });
  }
  s.sentThrough = pending[pending.length - 1].id;
  s.troubleAt = 0;
  dirty = true;
  persist();
}

function scheduleDrain(afterMs: number): void {
  if (drainTimer) clearTimeout(drainTimer);
  drainTimer = setTimeout(() => {
    drainTimer = null;
    idle(() => {
      // The editor may have closed while this waited for an idle moment, and
      // a timer armed after that is one nothing can clear.
      if (!sink) return;
      drainPerfLog();
      scheduleDrain(DRAIN_MIN_MS);
    });
  }, afterMs);
}

/**
 * Start keeping the log and sending it through `send`.
 *
 * The first drain, shortly after open, carries what the previous page left
 * behind — and a page that left unsent frames behind is one that never got to
 * send them, which is trouble in itself; later drains run a few minutes
 * apart. The page hiding writes and sends at once — the analytics client
 * beacons what it is handed there.
 */
export function startPerfLog(send: (batch: PerfLogBatch) => void): void {
  sink = send;
  if (typeof window === "undefined" || removePageHide) return;
  openedAt = openedAt || Date.now();
  // Rolled once for the page, not once per project opened in it: a dice throw
  // per editor mount would make the baseline a share of opens rather than a
  // share of sessions, and inflate the very population trouble is measured
  // against.
  if (!rolled) {
    rolled = true;
    sampled = Math.random() < SAMPLE_RATE;
  }
  const s = load();
  const stale = s.records.findIndex((r) => openedAt - r.at < KEEP_MS);
  if (stale !== 0) {
    s.records.splice(0, stale === -1 ? s.records.length : stale);
    dirty = true;
  }
  if (s.troubleAt && s.records.some((r) => r.id > s.sentThrough)) trouble = true;
  scheduleDrain(DRAIN_AFTER_OPEN_MS);
  const onHide = () => {
    if (document.visibilityState !== "hidden") return;
    persist();
    drainPerfLog();
  };
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", onHide);
  removePageHide = () => {
    document.removeEventListener("visibilitychange", onHide);
    window.removeEventListener("pagehide", onHide);
  };
}

/** Stop keeping the log, sending what is in hand first. */
export function stopPerfLog(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = null;
  if (drainTimer) clearTimeout(drainTimer);
  drainTimer = null;
  persist();
  drainPerfLog();
  removePageHide?.();
  removePageHide = null;
  sink = null;
}
