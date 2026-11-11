"use client";

/**
 * How loud a waveform is drawn.
 *
 * Peaks are measured amplitude, and speech into a phone held at arm's length
 * lands around a fifth of full scale. Drawn at true amplitude that is a line
 * one or two pixels tall inside a strip — the clip reads as having no sound at
 * all. A strip's job is the shape of the sound across the clip, so it is drawn
 * against the clip's own loudest moment.
 *
 * The lift is capped so a strip of room tone stays a strip of room tone: below
 * the cap the bars rise with the level rather than filling the strip.
 */
const MAX_GAIN = 8;

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

/** Multiplier to draw `peaks` with. 1 for an empty or already-full read. */
export function waveGain(peaks: readonly number[]): number {
  let max = 0;
  for (const p of peaks) if (p > max) max = p;
  if (!(max > 0)) return 1;
  return Math.min(MAX_GAIN, 1 / max);
}
