"use client";

/**
 * How tall a waveform is drawn.
 *
 * Bars follow loudness in decibels, as the ear hears it. On a linear scale a
 * key press a tenth of full scale is a bar a few pixels tall, and a press a
 * little softer than the loudest one shrinks to nothing; in decibels each
 * press stands near full height and the room between them sits as dots.
 *
 * A strip is drawn against the source's own loudest moment, so a quietly
 * recorded clip shows its shape. The reference never drops below
 * `WAVE_REF_MIN`, so a strip of room tone stays low.
 *
 *   level:  0 dB below the reference  → full height
 *          -18 dB                     → half
 *          -36 dB and quieter         → a dot
 */
const WAVE_RANGE_DB = 36;
const WAVE_REF_MIN = 1 / 8;

/** Waveform buckets per second of media. At the deepest zoom (800 px/s) a
 * bucket spans 4px — about one drawn bar — so the strip stays honest at every
 * zoom. */
export const PEAKS_PER_SECOND = 200;
/** Most buckets one source may hold. The array stays resident for the whole
 * session — on the asset and in the cache entry beside it — so length is what
 * bounds the memory a project of long sources costs. Anything up to five
 * minutes keeps the full density; past that the strip folds more of the
 * source into each bar the further in it is zoomed. */
const PEAKS_MAX = 60_000;
// Fewest buckets a source gets, and the count for one of unknown length.
const PEAKS_MIN = 400;
const PEAKS_UNKNOWN = 1600;

/** How many peak buckets a source of `duration` seconds is measured into. */
export function peakBuckets(duration: number): number {
  if (!(duration > 0)) {
    return PEAKS_UNKNOWN;
  }
  return Math.min(PEAKS_MAX, Math.max(PEAKS_MIN, Math.round(duration * PEAKS_PER_SECOND)));
}

/** The amplitude a strip of `peaks` is drawn against: its loudest peak. */
export function waveRef(peaks: readonly number[]): number {
  let max = 0;
  for (const p of peaks) {
    if (p > max) {
      max = p;
    }
  }
  return Math.max(WAVE_REF_MIN, max);
}

/** Bar height for peak `p`, 0..1, against the strip's `ref` (`waveRef`). */
export function waveLevel(p: number, ref: number): number {
  if (!(p > 0)) {
    return 0;
  }
  const db = 20 * Math.log10(p / ref);
  return Math.min(1, Math.max(0, 1 + db / WAVE_RANGE_DB));
}

/**
 * Fold one decoded chunk into `peaks`: each bucket keeps the loudest sample of
 * any channel in its stretch. Every sample counts — a key press is a click a
 * few milliseconds long, and a read that skips samples skips the click.
 *
 * `timestamp` is where the chunk starts in the source, `duration` the
 * source's length, both in seconds.
 */
export function foldPeaks(
  peaks: number[],
  channels: readonly Float32Array[],
  timestamp: number,
  rate: number,
  duration: number
) {
  const buckets = peaks.length;
  const len = channels[0]?.length ?? 0;
  const perSecond = buckets / duration;

  // Walk the chunk a bucket at a time: find the samples it covers, then take
  // their loudest across every channel.
  let i = 0;
  while (i < len) {
    const at = Math.floor((timestamp + i / rate) * perSecond);
    const bucket = Math.min(buckets - 1, Math.max(0, at));
    const end =
      bucket === buckets - 1
        ? len
        : Math.min(len, Math.max(i + 1, Math.ceil(((bucket + 1) / perSecond - timestamp) * rate)));
    let max = peaks[bucket];
    for (const data of channels) {
      for (let j = i; j < end; j++) {
        const v = data[j] < 0 ? -data[j] : data[j];
        if (v > max) {
          max = v;
        }
      }
    }
    peaks[bucket] = max;
    i = end;
  }
}

/** The loudest of `peaks` under bar `i` of `bars` spread across them all. */
export function barPeak(peaks: readonly number[], i: number, bars: number): number {
  const n = peaks.length;
  const a = Math.min(n - 1, Math.floor((i / bars) * n));
  const b = Math.max(a + 1, Math.floor(((i + 1) / bars) * n));
  let max = 0;
  for (let j = a; j < b && j < n; j++) {
    if (peaks[j] > max) {
      max = peaks[j];
    }
  }
  return max;
}
