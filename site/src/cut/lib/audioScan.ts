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

/** A source's musical beat grid. */
export interface BeatScan {
  /** Beat moments in source seconds, ascending. */
  beats: number[];
  /** Tempo of the grid, beats per minute; 0 when no steady pulse was heard. */
  bpm: number;
}

// The beat scan hears music the way the level fold cannot: a bass drop or a
// synth swell moves the RMS while the pulse hides inside it. So the fold here
// is spectral — each analysis window becomes a magnitude spectrum, and an
// onset is the frame where energy APPEARS across bins (half-wave rectified
// spectral flux on log magnitudes). Tempo is the onset train's strongest
// periodicity, and the beats themselves come from a dynamic program that
// walks the onsets at that period while giving a little to follow the player.

/** Analysis window, seconds. Rounded to a power of two of the stream's rate. */
const BEAT_WIN_S = 0.046;
/** The highest rate the beat scan analyzes at. Onsets live in spectral flux a
 * few kHz up at most, so a source above this folds down to it: the window
 * shrinks with the rate and the arithmetic inside each FFT with it, while the
 * hop stays the same slice of time — the grid keeps its accuracy and a long
 * file costs a fraction of what a full-rate scan would. A source already
 * below it is read as it is; resampling upward would only invent detail. */
const BEAT_RATE = 11025;
/** Log compression of the magnitudes, so quiet hits register beside loud ones. */
const FLUX_GAMMA = 100;
/** The local-mean window that turns flux into onsets, seconds each side. */
const FLUX_MEAN_S = 0.5;
/** Tempo prior: a pulse near 120 BPM is the likeliest read... */
const TEMPO_CENTER_S = 0.5;
/** ...with an octave of width either way. */
const TEMPO_WIDTH_OCT = 1.0;
/** Fastest tempo considered — 240 BPM. */
const TEMPO_MIN_S = 0.25;
/** Slowest tempo considered — 50 BPM. */
const TEMPO_MAX_S = 1.2;
/** Onset autocorrelation under this share of the train's energy is no pulse. */
const MIN_PERIODICITY = 0.1;
/** Onsets under this per-bin flux are the numeric floor — a steady tone's
 * leakage ripple beats against the hop grid periodically, and real music sits
 * orders of magnitude above it. */
const MIN_ONSET_LEVEL = 0.01;
/** How hard the tracker holds the tempo against the onsets' pull. */
const TIGHTNESS = 100;
/** A grid needs at least this many beats to be one. */
const MIN_BEATS = 4;
/** An edge beat holds only with onset energy under it, so the grid stops
 * where the music does: at least this much on the rms-normalized envelope... */
const EDGE_SUPPORT = 0.1;
/** ...and at least this share of the median beat's — a noise floor sits well
 * under the hits however the normalization landed. */
const EDGE_SHARE = 0.2;

/** In-place radix-2 FFT over split re/im arrays (length a power of two). */
function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j |= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/**
 * The beat grid behind an onset envelope: tempo by autocorrelation under a
 * log-Gaussian prior, then beat placement by dynamic programming — each frame
 * either extends a chain one period back (give or take, at a log-time cost)
 * or starts fresh, and the best-scoring chain is the grid. `t0` is the source
 * second of frame 0, `hopSec` the frame width.
 */
export function beatsFromOnsets(flux: Float32Array, hopSec: number, t0: number): BeatScan {
  const n = flux.length;
  const none: BeatScan = { beats: [], bpm: 0 };
  if (n * hopSec < 2) return none;

  // Onset strength: flux over its local mean, so a swell carries no onsets
  // and a hit in a quiet bar counts beside one in a loud chorus.
  const half = Math.max(1, Math.round(FLUX_MEAN_S / hopSec));
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + flux[i];
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    o[i] = Math.max(0, flux[i] - (prefix[b] - prefix[a]) / (b - a));
  }
  let sq = 0;
  for (let i = 0; i < n; i++) sq += o[i] * o[i];
  const rms = Math.sqrt(sq / n);
  if (rms < MIN_ONSET_LEVEL) return none;
  for (let i = 0; i < n; i++) o[i] /= rms;

  // Tempo: the onset train's autocorrelation, weighted toward middle tempi.
  const lagMin = Math.max(1, Math.round(TEMPO_MIN_S / hopSec));
  const lagMax = Math.min(n - 1, Math.round(TEMPO_MAX_S / hopSec));
  if (lagMax <= lagMin) return none;
  const score = new Float64Array(lagMax + 1);
  let bestLag = 0;
  let periodicity = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let r = 0;
    for (let i = 0; i + lag < n; i++) r += o[i] * o[i + lag];
    r /= n - lag;
    const oct = Math.log2((lag * hopSec) / TEMPO_CENTER_S) / TEMPO_WIDTH_OCT;
    score[lag] = r * Math.exp(-0.5 * oct * oct);
    if (bestLag === 0 || score[lag] > score[bestLag]) {
      bestLag = lag;
      periodicity = r;
    }
  }
  // The envelope is rms-normalized, so its per-frame energy is 1 and the raw
  // autocorrelation reads directly as a share of it.
  if (periodicity < MIN_PERIODICITY) return none;
  let period = bestLag;
  if (bestLag > lagMin && bestLag < lagMax) {
    const y0 = score[bestLag - 1];
    const y1 = score[bestLag];
    const y2 = score[bestLag + 1];
    const d = y0 - 2 * y1 + y2;
    if (d < 0) period = bestLag + (0.5 * (y0 - y2)) / d;
  }

  // Beat placement: chain onsets a period apart, log-time cost on the slack.
  const winLo = Math.max(1, Math.round(period / 2));
  const winHi = Math.round(period * 2);
  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let bestS = 0;
    let bestJ = -1;
    for (let j = Math.max(0, i - winHi); j <= i - winLo; j++) {
      const slack = Math.log((i - j) / period);
      const s = cum[j] - TIGHTNESS * slack * slack;
      if (s > bestS) {
        bestS = s;
        bestJ = j;
      }
    }
    cum[i] = o[i] + (bestJ >= 0 ? bestS : 0);
    back[i] = bestJ;
  }
  let end = 0;
  for (let i = 1; i < n; i++) if (cum[i] > cum[end]) end = i;
  const idx: number[] = [];
  for (let i = end; i >= 0; i = back[i]) idx.push(i);
  idx.reverse();

  // The chain drifts on through leading and trailing quiet at pure penalty;
  // drop edge beats with nothing under them, so the grid spans the music.
  const support = (k: number) => {
    let m = 0;
    for (let j = Math.max(0, k - 2); j <= Math.min(n - 1, k + 2); j++) m = Math.max(m, o[j]);
    return m;
  };
  const supports = idx.map(support);
  const median = supports.slice().sort((a, b) => a - b)[Math.floor(supports.length / 2)] ?? 0;
  const floor = Math.max(EDGE_SUPPORT, EDGE_SHARE * median);
  let lo = 0;
  let hi = idx.length;
  while (lo < hi && supports[lo] < floor) lo++;
  while (hi > lo && supports[hi - 1] < floor) hi--;
  const kept = idx.slice(lo, hi);
  if (kept.length < MIN_BEATS) return none;

  return {
    beats: kept.map((k) => round3(t0 + k * hopSec)),
    bpm: Math.round((60 / (period * hopSec)) * 10) / 10,
  };
}

/**
 * The beat grid in `chunks`, in absolute source seconds.
 *
 * Everything runs on one fixed analysis grid at BEAT_RATE: each chunk is
 * folded down to it as it arrives, so a source whose decoder answers with a
 * different sample rate partway through still lands every sample in the right
 * place, and an hour-long file costs the frames its length deserves rather
 * than the frames its sample rate would buy.
 */
export async function scanBeats(chunks: AsyncIterable<PcmChunk>): Promise<BeatScan> {
  // The analysis rate is settled by the first chunk and holds for the scan.
  // The grid it defines is in absolute source time, so a later chunk arriving
  // at a different rate still folds onto it in the right place.
  let ar = 0;
  let win = 0;
  let hop = 0;
  let ring = new Float32Array(0);
  let hann = new Float32Array(0);
  let re = new Float32Array(0);
  let im = new Float32Array(0);
  let prev = new Float32Array(0);
  const flux: number[] = [];
  let base0 = -1;
  let filled = 0;

  const frame = () => {
    for (let i = 0; i < win; i++) {
      re[i] = ring[(filled - win + i) % win] * hann[i];
      im[i] = 0;
    }
    fft(re, im);
    let f = 0;
    for (let k = 1; k < win / 2; k++) {
      const m = Math.log1p(FLUX_GAMMA * Math.sqrt(re[k] * re[k] + im[k] * im[k]));
      const d = m - prev[k];
      if (d > 0) f += d;
      prev[k] = m;
    }
    // Per bin, so the envelope reads the same at every sample rate — and the
    // first window, with nothing behind it, reads as zero by definition.
    flux.push(flux.length === 0 && filled === win ? 0 : f / (win >> 1));
  };

  const push = (v: number) => {
    ring[filled % win] = v;
    filled++;
    if (filled >= win && (filled - win) % hop === 0) frame();
  };

  // The analysis sample being folded: every source sample landing on it
  // averages in, so decimating a 48 kHz file never drops a transient between
  // the samples it keeps.
  let foldAt = NaN;
  let foldSum = 0;
  let foldN = 0;
  const fold = () => {
    if (foldN === 0) return;
    const v = foldSum / foldN;
    foldSum = 0;
    foldN = 0;
    const at = foldAt - base0;
    if (at < filled) return; // already covered — chunks that overlap
    // A step up in rate (or a hole in the stream) holds the level rather than
    // dropping to zero, so the fill itself reads as no onset at all.
    while (filled < at) push(v);
    push(v);
  };

  for await (const { channels, timestamp, sampleRate } of chunks) {
    if (channels.length === 0 || channels[0].length === 0) continue;
    if (!(sampleRate > 0)) continue;
    if (ar === 0) {
      ar = Math.min(BEAT_RATE, sampleRate);
      win = 1 << Math.round(Math.log2(BEAT_WIN_S * ar));
      hop = win >> 2;
      ring = new Float32Array(win);
      re = new Float32Array(win);
      im = new Float32Array(win);
      prev = new Float32Array(win / 2);
      hann = new Float32Array(win);
      for (let i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win);
    }
    const length = channels[0].length;
    const step = ar / sampleRate;
    // Sample positions rebuild from an index on the analysis grid, so neither
    // a chunk split nor a change of sample rate can move the frame grid
    // (scanEnvelope does the same).
    const base = timestamp * ar;
    for (let i = 0; i < length; i++) {
      const at = Math.floor(base + i * step);
      if (at !== foldAt) {
        fold();
        foldAt = at;
        if (base0 < 0) base0 = at;
      }
      let v = 0;
      for (const ch of channels) v += ch[i];
      foldSum += v / channels.length;
      foldN++;
    }
  }
  fold();
  if (ar === 0 || flux.length === 0) return { beats: [], bpm: 0 };

  // A frame's flux belongs to the hop of samples that entered the window for
  // it; its moment is the middle of that hop.
  const t0 = (base0 + win - hop / 2) / ar;
  return beatsFromOnsets(Float32Array.from(flux), hop / ar, t0);
}
