// Snap transcribed cues onto the speech they describe.
//
// Every transcriber mistimes a caption in its own way. The on-device model
// hands the silence before a sentence to that sentence's first word, so a cue
// opening an utterance can appear a full second before anyone speaks; the
// hosted model reads times off the audio by ear and misses by a beat either
// way. The mix they transcribed is right here, so the times get checked against
// it: a 10 ms energy envelope marks where speech runs, and each cue edge moves
// to the speech edge it belongs to. Pure arithmetic over the samples — the
// engine runs it on the wav it just rendered, the browser on the mix it posted,
// and neither needs a model or the network.
//
// Only what the audio can testify to moves. An edge counts as evidence when
// real quiet sits on its far side, so a cue boundary in the middle of a
// sentence — where nothing audible says one caption ends and the next begins —
// keeps the time the transcriber gave it, and a mix that never goes quiet (a
// wall of music) supplies no edges at all. A start may travel a long way
// forward to meet the voice it captions and only a little way back, because
// silence proves nobody was speaking yet and proves nothing about a word that
// came earlier.

/** Word timings as the transcriber and the editor both carry them. */
export interface AlignWord {
  t0: number;
  t1: number;
  w: string;
}

/** The part of a cue this cares about; cue ids, text, and lanes ride through. */
export interface AlignCue {
  start: number;
  end: number;
  words?: AlignWord[];
}

/** Envelope frame length, seconds — the resolution every time here lands on. */
const HOP = 0.01;
/** How far an edge may travel backward (and a cue end either way) to meet a
 * speech edge. */
const SNAP = 0.35;
/** How far a cue start may travel forward to meet the voice it captions — the
 * silence a transcriber hands to a sentence's first word runs this long. */
const LEAD = 1.5;
/** A run of speech shorter than this is a click; a gap shorter than this sits
 * inside a word rather than between two of them. */
const MIN_RUN = 0.06;
const BRIDGE = 0.12;
/** An edge is evidence when this much quiet sits on its far side, within this
 * many dB of the mix's own floor. A drum hit under a music bed says nothing
 * about where a sentence starts, and this is what keeps it from being read
 * that way. */
const QUIET_RUN = 0.15;
const QUIET_MARGIN = 6;
/** A cue never collapses below this while being snapped. */
const MIN_CUE = 0.2;
/** Speech and cues must overlap at least this well before any of this is
 * trusted — below it the envelope is describing something other than the
 * transcript (music, noise, a bad read) and the cues are left alone. */
const MIN_IOU = 0.35;

const round = (n: number) => Math.round(n * 1000) / 1000;

/** A stretch of audio carrying speech. `cleanStart`/`cleanEnd` mark the edges
 * that quiet sits against — the ones a cue boundary may be snapped to. */
export interface SpeechSpan {
  start: number;
  end: number;
  cleanStart: boolean;
  cleanEnd: boolean;
}

/** The stretches of the audio that carry speech, in seconds. Frames whose
 * energy rises well above the mix's own noise floor open a run and quiet ones
 * close it (two thresholds, so a wavering syllable can't chatter the run open
 * and shut). Null when the audio has nothing to say about where speech is:
 * digital silence, or a level so flat that every frame looks alike. */
export function speechSpans(samples: ArrayLike<number>, rate: number): SpeechSpan[] | null {
  const hop = Math.max(1, Math.round(rate * HOP));
  const frames = Math.floor(samples.length / hop);
  if (frames < 4) return null;

  // Frame energy after pre-emphasis: speech lives above the low rumble a music
  // bed or room tone carries, and differencing the samples leans the envelope
  // that way. Levels stay relative to the loudest frame, so this reads the same
  // whether the caller hands over floats or 16-bit integers.
  const db = new Float32Array(frames);
  let peakRms = 0;
  let prev = 0;
  let i = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const stop = (f + 1) * hop;
    for (; i < stop; i++) {
      const x = samples[i];
      const v = x - 0.97 * prev;
      prev = x;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / hop);
    db[f] = rms;
    if (rms > peakRms) peakRms = rms;
  }
  if (peakRms <= 0) return null;
  for (let f = 0; f < frames; f++) db[f] = 20 * Math.log10(db[f] / peakRms + 1e-6);

  const sorted = Float32Array.from(db).sort();
  const at = (q: number) => sorted[Math.min(frames - 1, Math.floor(q * frames))];
  const floor = at(0.1);
  const loud = at(0.9);
  if (loud - floor < 12) return null; // no dynamics to read edges from

  const enter = floor + (loud - floor) * 0.45;
  const exit = floor + (loud - floor) * 0.25;
  const runs: { from: number; to: number }[] = [];
  let open = -1;
  for (let f = 0; f < frames; f++) {
    if (open < 0) {
      if (db[f] >= enter) open = f;
    } else if (db[f] < exit) {
      runs.push({ from: open, to: f });
      open = -1;
    }
  }
  if (open >= 0) runs.push({ from: open, to: frames });

  const merged: { from: number; to: number }[] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && (run.from - last.to) * HOP <= BRIDGE) last.to = run.to;
    else merged.push({ ...run });
  }
  const kept = merged.filter((r) => (r.to - r.from) * HOP >= MIN_RUN);
  if (kept.length === 0) return null;
  // Speech everywhere means no edges worth snapping to — a bed of music under
  // the whole cut reads this way.
  const covered = kept.reduce((n, r) => n + (r.to - r.from) * HOP, 0);
  if (covered > 0.95 * frames * HOP) return null;

  // Quiet is what makes an edge readable. A run of frames near the floor
  // before a span means its first word really does start there; audio that
  // merely dips (a bed under the whole cut) leaves the edge unusable.
  const quietBefore = floor + QUIET_MARGIN;
  const span = Math.round(QUIET_RUN / HOP);
  const isQuiet = (from: number, to: number) => {
    for (let f = Math.max(0, from); f < Math.min(frames, to); f++) {
      if (db[f] > quietBefore) return false;
    }
    return true;
  };
  return kept.map((r) => ({
    start: r.from * HOP,
    end: r.to * HOP,
    cleanStart: r.from === 0 || isQuiet(r.from - span, r.from),
    cleanEnd: r.to === frames || isQuiet(r.to, r.to + span),
  }));
}

/** A frame-level 0/1 mask of the spans, over `frames` frames. */
function maskOf(spans: readonly { start: number; end: number }[], frames: number): Uint8Array {
  const mask = new Uint8Array(frames);
  for (const s of spans) {
    const from = Math.max(0, Math.floor(s.start / HOP));
    const to = Math.min(frames, Math.ceil(s.end / HOP));
    for (let f = from; f < to; f++) mask[f] = 1;
  }
  return mask;
}

/** How well the transcript and the audible speech describe the same thing:
 * intersection over union of the two masks. A low score means the envelope is
 * about something other than these cues, and nothing should be moved on it. */
function overlap(cues: Uint8Array, speech: Uint8Array): number {
  let cueTotal = 0;
  let speechTotal = 0;
  let hit = 0;
  for (let f = 0; f < cues.length; f++) {
    cueTotal += cues[f];
    speechTotal += speech[f];
    if (cues[f] === 1 && speech[f] === 1) hit++;
  }
  if (cueTotal === 0 || speechTotal === 0) return 0;
  return hit / (cueTotal + speechTotal - hit);
}

/** The value in `sorted` closest to `t` within [`t - back`, `t + ahead`], and
 * inside [`floor`, `ceil`]. Null when the audio offers no edge there. */
function nearest(
  sorted: number[],
  t: number,
  back: number,
  ahead: number,
  floor: number,
  ceil: number
): number | null {
  let best: number | null = null;
  let bestGap = Infinity;
  for (const v of sorted) {
    if (v < t - back || v < floor) continue;
    if (v > t + ahead) break;
    if (v > ceil) break;
    const gap = Math.abs(v - t);
    if (gap < bestGap) {
      bestGap = gap;
      best = v;
    }
  }
  return best;
}

/**
 * Re-time cues against the audio they were transcribed from. Cues come back in
 * the same order with their ids, text, and lanes intact, and word timings ride
 * along with them. A cue the audio has nothing to say about arrives unchanged,
 * as does every cue when the mix as a whole disagrees with the transcript.
 *
 * `snap` widens the backward search for a transcriber whose times are guesses
 * (the hosted model) over one that reports real word ranges.
 */
export function alignCues<T extends AlignCue>(
  cues: T[],
  samples: ArrayLike<number>,
  rate: number,
  opts: { snap?: number } = {}
): T[] {
  if (cues.length === 0 || rate <= 0) return cues;
  const spans = speechSpans(samples, rate);
  if (!spans) return cues;

  const frames = Math.max(1, Math.ceil(samples.length / rate / HOP));
  const fit = overlap(
    maskOf(cues.map((c) => ({ start: c.start, end: c.end })), frames),
    maskOf(spans, frames)
  );
  if (fit < MIN_IOU) return cues; // the audio is describing something else

  const back = opts.snap ?? SNAP;
  const onsets = spans.filter((s) => s.cleanStart).map((s) => s.start);
  const offsets = spans.filter((s) => s.cleanEnd).map((s) => s.end);
  const roomFor = (cue: AlignCue) => Math.min(MIN_CUE, Math.max(0.05, cue.end - cue.start));

  // Starts first: each looks for the voice its caption belongs to, reaching
  // well ahead to cross the silence a transcriber hands to a sentence's first
  // word, stopping short of the cue's own end so the caption keeps a life on
  // screen, and never opening before the cue in front of it.
  const starts: number[] = [];
  for (const [i, cue] of cues.entries()) {
    const floor = i > 0 ? starts[i - 1] : 0;
    const ceil = cue.end - roomFor(cue);
    starts.push(
      Math.max(floor, nearest(onsets, cue.start, back, LEAD, floor, ceil) ?? cue.start)
    );
  }

  // Ends then close inside the room the next cue's start leaves, which is what
  // keeps captions on a track from ever overlapping.
  return cues.map((cue, i) => {
    const start = starts[i];
    const ceil = i + 1 < cues.length ? starts[i + 1] : Infinity;
    const minLen = Math.max(0.01, Math.min(roomFor(cue), ceil - start));
    const end = Math.max(
      start + minLen,
      Math.min(ceil, nearest(offsets, cue.end, back, back, start, ceil) ?? cue.end)
    );

    // Word timings follow the edge that moved. A cue that slid whole carries
    // its cadence along; one whose start met a later onset keeps every interior
    // word where the transcriber put it and pulls in only the leading word —
    // the one the silence was wrongly attached to.
    const shift = start - cue.start;
    const slid = Math.abs(end - start - (cue.end - cue.start)) <= 3 * HOP;
    const words = cue.words?.map((w) => {
      const at = (t: number) => round(Math.min(end, Math.max(start, slid ? t + shift : t)));
      return { ...w, t0: at(w.t0), t1: at(w.t1) };
    });
    return { ...cue, start: round(start), end: round(end), ...(words ? { words } : {}) };
  });
}
