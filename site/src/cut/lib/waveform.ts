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

/** Multiplier to draw `peaks` with. 1 for an empty or already-full read. */
export function waveGain(peaks: readonly number[]): number {
  let max = 0;
  for (const p of peaks) if (p > max) max = p;
  if (!(max > 0)) return 1;
  return Math.min(MAX_GAIN, 1 / max);
}
