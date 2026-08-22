/**
 * Folding decoded audio into an answer, a chunk at a time.
 *
 * Audio arrives from the reader in whatever spans the decoder hands back, so
 * anything measured over a window — level, in practice — has to carry its
 * running state across chunk seams. Keeping that fold here, over plain sample
 * arrays, is what lets it be tested without a decoder.
 *
 * Everything else in this file reads the one thing the fold produces: an
 * envelope, a level per frame. Silence is a fixed threshold over it; speech is
 * a measurement of the recording's own two levels, which is what a cut needs.
 */

/** Decoded PCM for one span: one array per channel, all the same length. */
export interface PcmChunk {
  channels: Float32Array[];
  /** Where this span starts, in source seconds. */
  timestamp: number;
  sampleRate: number;
}

export interface SilenceSpan {
  start: number;
  end: number;
  duration: number;
}

export interface SilenceOptions {
  /** Absolute source seconds the scan covers; `to` open-ended when omitted. */
  from: number;
  to?: number;
  /** Level below which a window counts as silent, in dBFS. */
  thresholdDb: number;
  /** Shorter runs of silence are not reported. */
  minSilence: number;
}

/** The measurement window, in seconds — what ffmpeg's silencedetect uses. */
const WINDOW = 0.02;

/** The speech scan's frame. Half the silence window, because a word boundary
 * placed to the nearest 20ms is audibly late and one placed to 10ms is not. */
const SPEECH_HOP = 0.01;

/** Digital silence reads as this many dBFS, so every level is a real number. */
const QUIET = -100;

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Level per frame across a span of source audio. */
export interface Envelope {
  /** Frame level in dBFS; NaN where the decoder handed back no samples. */
  db: Float32Array;
  /** Source seconds at the left edge of frame 0. */
  from: number;
  /** Frame width, seconds. */
  hop: number;
  /** Source seconds where the audio ran out. */
  end: number;
}

/**
 * Fold `chunks` into one level per frame.
 *
 * Frames sit on a fixed grid anchored at `from` rather than starting wherever
 * the previous chunk ended. That is what makes the answer independent of how
 * the decoder happened to split the audio: a boundary is a property of the
 * timeline, so a chunk that starts mid-frame is measured into the frame it
 * belongs to instead of starting a new one. A frame no sample landed in reads
 * NaN — the decoder said nothing about it, which is different from silence.
 */
export async function scanEnvelope(
  chunks: AsyncIterable<PcmChunk>,
  opts: { from: number; to?: number; hop?: number }
): Promise<Envelope> {
  const { from, to } = opts;
  const hop = opts.hop ?? WINDOW;
  const db: number[] = [];

  let index = -1;
  let end = from;
  let sum = 0;
  let count = 0;

  /** Write the frame that just filled and clear the accumulator. */
  const settle = () => {
    if (index >= 0) {
      while (db.length < index) db.push(NaN);
      const rms = count > 0 ? Math.sqrt(sum / count) : 0;
      db[index] = count > 0 ? Math.max(QUIET, 20 * Math.log10(rms || 1e-12)) : NaN;
    }
    sum = 0;
    count = 0;
  };

  for await (const { channels, timestamp, sampleRate } of chunks) {
    if (channels.length === 0) continue;
    const length = channels[0].length;
    // Sample times rebuild from an integer sample index, so a chunk split
    // cannot move a boundary sample across a frame by a rounding error.
    const base = Math.round(timestamp * sampleRate);
    for (let i = 0; i < length; i++) {
      const at = (base + i) / sampleRate;
      if (at < from) continue;
      if (to !== undefined && at >= to) break;
      const frame = Math.floor((at - from) / hop);
      if (frame !== index) {
        settle();
        index = frame;
      }
      for (const ch of channels) sum += ch[i] * ch[i];
      count += channels.length;
      end = at + 1 / sampleRate;
    }
  }
  settle();
  return { db: Float32Array.from(db), from, hop, end };
}

/**
 * Silent spans of an envelope: runs of frames under `thresholdDb` lasting at
 * least `minSilence`. Frames the decoder never filled neither open nor close a
 * run, so a gap in the decode is not heard as a pause.
 */
export function silencesFrom(
  env: Envelope,
  opts: { thresholdDb: number; minSilence: number; to?: number }
): SilenceSpan[] {
  const { from, hop, db } = env;
  const silences: SilenceSpan[] = [];
  const at = (index: number) => from + index * hop;
  let open: number | null = null;

  const close = (endT: number) => {
    if (open !== null && endT - open >= opts.minSilence) {
      const start = round2(Math.max(from, open));
      const stop = round2(endT);
      if (stop > start) silences.push({ start, end: stop, duration: round2(stop - start) });
    }
    open = null;
  };

  for (let i = 0; i < db.length; i++) {
    if (!Number.isFinite(db[i])) continue;
    if (db[i] < opts.thresholdDb) open ??= at(i);
    else close(at(i));
  }
  close(opts.to !== undefined ? Math.min(opts.to, env.end) : env.end);
  return silences;
}

/** Silent spans in `chunks`, by RMS over 20ms windows. */
export async function scanSilence(
  chunks: AsyncIterable<PcmChunk>,
  opts: SilenceOptions
): Promise<SilenceSpan[]> {
  const env = await scanEnvelope(chunks, { from: opts.from, to: opts.to });
  return silencesFrom(env, opts);
}

/** A run of speech, tail and soft attack included. */
export interface SpeechSegment {
  start: number;
  end: number;
  /** The loudest frame in the run, dBFS — how much of the voice this is. */
  peakDb: number;
}

export interface SpeechScan {
  /** Speech runs in source seconds, in order, never touching. */
  segments: SpeechSegment[];
  from: number;
  to: number;
  /** Room tone as measured, dBFS. */
  floorDb: number;
  /** The level the voice sits at, dBFS. */
  speechDb: number;
  /** What a frame has to clear to open a word, dBFS. */
  onsetDb: number;
  /** True when quiet and loud separate cleanly. False under a music bed or in
   * a range that is speech end to end — the segments are still the best read
   * of it, they just carry less authority. */
  separated: boolean;
}

// How the two levels are told apart. Every number here is about human speech:
// a talker's quiet decile is room tone, their loud decile is a vowel, and the
// distance between the two is the recording's headroom.
const FLOOR_Q = 0.1;
const SPEECH_Q = 0.95;
/** Headroom that makes a room readable — quiet and loud clearly two things. */
const SEPARATION = 20;
/** In a readable room the word opens this far over the floor, at least. */
const LIFT_MIN = 6;
/** …or this share of the headroom, whichever asks more. */
const LIFT_SHARE = 0.35;
/** The threshold never comes within this of the voice itself. */
const HEADROOM = 10;
/** Where the two levels sit on top of each other, read down from the voice. */
const CROWDED = 12;
/** A word holds while it decays this far under the level that opened it. */
const RELEASE = 8;
/** …and is over once it has stayed down for this long. */
const HANG = 0.05;
/** Energy this brief is a click, a lip smack, a chair. */
const MIN_ONSET = 0.03;
/** A gap this short is inside a word — the closure in a "t", a glottal stop. */
const BRIDGE = 0.09;
/** A run shorter than this is not a word. */
const MIN_SEGMENT = 0.06;
/** Nothing in a range this quiet is speech, however the levels fall out. */
const SILENT_RANGE = -55;
/** No threshold reaches below this, whatever the floor measures. */
const DEEPEST = -75;

const quantile = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];

/**
 * Where the words are.
 *
 * A fixed dB threshold answers this badly: it calls a noisy room continuous
 * speech and a quiet one continuous silence, and either way the cut lands in
 * the wrong place. So the levels come from the recording — its floor and its
 * voice — and the threshold is set between them. A word opens when the level
 * clears that threshold and stays open while it decays, so the tail of a word
 * belongs to the word; the soft attack ahead of it does too. Gaps too short to
 * be a pause are bridged, and energy too brief to be a word is dropped.
 */
export function speechFrom(env: Envelope): SpeechScan {
  const { db, from, hop } = env;
  const to = Math.min(env.end, from + db.length * hop);
  const at = (index: number) => from + index * hop;

  const heard: number[] = [];
  for (let i = 0; i < db.length; i++) if (Number.isFinite(db[i])) heard.push(db[i]);
  const empty = (floorDb: number, speechDb: number, onsetDb: number, separated: boolean) => ({
    segments: [],
    from: round3(from),
    to: round3(to),
    floorDb: round2(floorDb),
    speechDb: round2(speechDb),
    onsetDb: round2(onsetDb),
    separated,
  });
  if (heard.length === 0) return empty(QUIET, QUIET, QUIET, false);

  heard.sort((a, b) => a - b);
  const floorDb = quantile(heard, FLOOR_Q);
  const speechDb = quantile(heard, SPEECH_Q);
  if (speechDb < SILENT_RANGE) return empty(floorDb, speechDb, SILENT_RANGE, true);

  const spread = speechDb - floorDb;
  const separated = spread >= SEPARATION;
  const onsetDb = Math.max(
    DEEPEST,
    separated
      ? Math.min(floorDb + Math.max(LIFT_MIN, spread * LIFT_SHARE), speechDb - HEADROOM)
      : speechDb - CROWDED
  );
  const releaseDb = Math.min(onsetDb, Math.max(onsetDb - RELEASE, floorDb + 3));

  const onsetFrames = Math.max(1, Math.round(MIN_ONSET / hop));
  const raw: { start: number; end: number }[] = [];
  let open = -1;
  let last = -1;
  let run = 0;
  for (let i = 0; i < db.length; i++) {
    const level = db[i];
    if (!Number.isFinite(level)) continue;
    if (open < 0) {
      if (level < onsetDb) {
        run = 0;
        continue;
      }
      if (++run < onsetFrames) continue;
      // Back over the soft attack: a fricative or an intake of breath ahead of
      // the vowel sits under the onset level and is still part of the word.
      let start = i - run + 1;
      while (start > 0 && Number.isFinite(db[start - 1]) && db[start - 1] >= releaseDb) start--;
      open = start;
      last = i;
      run = 0;
    } else if (level >= releaseDb) {
      last = i;
    } else if (at(i) - at(last) >= HANG) {
      raw.push({ start: at(open), end: at(last) + hop });
      open = -1;
    }
  }
  if (open >= 0) raw.push({ start: at(open), end: Math.min(at(last) + hop, to) });

  const merged: { start: number; end: number }[] = [];
  for (const seg of raw) {
    const prev = merged[merged.length - 1];
    if (prev && seg.start - prev.end < BRIDGE) prev.end = seg.end;
    else merged.push({ ...seg });
  }

  const segments: SpeechSegment[] = [];
  for (const seg of merged) {
    if (seg.end - seg.start < MIN_SEGMENT) continue;
    let peak = QUIET;
    const first = Math.max(0, Math.floor((seg.start - from) / hop));
    const stop = Math.min(db.length, Math.ceil((seg.end - from) / hop));
    for (let i = first; i < stop; i++) if (Number.isFinite(db[i]) && db[i] > peak) peak = db[i];
    segments.push({ start: round3(seg.start), end: round3(Math.min(seg.end, to)), peakDb: round2(peak) });
  }

  return {
    segments,
    from: round3(from),
    to: round3(to),
    floorDb: round2(floorDb),
    speechDb: round2(speechDb),
    onsetDb: round2(onsetDb),
    separated,
  };
}

/** Where the words are in `chunks`. */
export async function scanSpeech(
  chunks: AsyncIterable<PcmChunk>,
  opts: { from: number; to?: number }
): Promise<SpeechScan> {
  const env = await scanEnvelope(chunks, { ...opts, hop: SPEECH_HOP });
  return speechFrom(env);
}
