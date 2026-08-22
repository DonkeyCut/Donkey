/**
 * When each word of a piece of on-screen text is actually said.
 *
 * The transcript is the cut's clock: it knows when every recognized word was
 * spoken. A title the user placed carries their exact wording, so the two are
 * aligned word for word — the text stays verbatim and only the times come
 * from the transcript, the same bargain a lyric sync makes. Nothing to align
 * against (no captions yet, a title over silence) hands back nothing, and the
 * emphasis falls back to an even share of the element's own span.
 */

import { displayWords } from "@donkeycut/effects-kit";
import { syncLines, type TimedWord } from "./lyricSync";
import type { SubtitleCue } from "./types";

/** The transcript an element is timed against: the first subtitle track. The
 * others are translations of it, and aligning English words to a Korean
 * translation would anchor nothing. */
const primaryCues = (cues: SubtitleCue[]): SubtitleCue[] => cues.filter((c) => (c.lane ?? 0) === 0);

/** Every transcript word the cut carries, in order. A cue with no word times
 * of its own contributes an even split of its line, so a hand-typed caption
 * still lends a usable clock. */
export function transcriptWords(
  cues: { start: number; end: number; text: string; words?: TimedWord[] }[]
): TimedWord[] {
  const out: TimedWord[] = [];
  for (const c of cues) {
    if (c.words && c.words.length > 0) {
      out.push(...c.words);
      continue;
    }
    const parts = c.text.split(/\s+/).filter((w) => w.length > 0);
    const step = parts.length > 0 ? (c.end - c.start) / parts.length : 0;
    parts.forEach((w, i) => out.push({ w, t0: c.start + step * i, t1: c.start + step * (i + 1) }));
  }
  return out;
}

/**
 * Word onsets for one text element, seconds from its own start — what the
 * word-emphasis slot follows. Undefined when the transcript says nothing
 * about this stretch of the cut.
 */
export function wordTimesFor(
  o: { text: string; start: number; end: number },
  cues: SubtitleCue[]
): number[] | undefined {
  const count = displayWords(o.text).length;
  if (count === 0) return undefined;
  const heard = transcriptWords(primaryCues(cues)).filter((w) => w.t1 > o.start && w.t0 < o.end);
  if (heard.length === 0) return undefined;
  const line = syncLines([o.text], heard, { from: o.start, to: o.end })[0];
  if (!line?.words || line.words.length !== count) return undefined;
  const dur = Math.max(0, o.end - o.start);
  const times: number[] = [];
  let floor = 0;
  for (const w of line.words) {
    floor = Math.min(Math.max(w.t0 - o.start, floor), dur);
    times.push(Math.round(floor * 1000) / 1000);
  }
  return times;
}
