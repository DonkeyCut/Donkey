/**
 * How many words a caption holds at once.
 *
 * A transcriber groups its words its own way — the on-device model breaks on
 * punctuation and a character budget — and that grouping is what a caption
 * reads like: three words at a time is a fast, punchy read, ten is a
 * paragraph parked over the picture. The project carries the number and this
 * is where a track is cut to it.
 *
 * Cues are cut from words, not from lines. A word carries the moment the
 * transcriber measured it at, so a group's edges are real onsets and the
 * caption changes when the speech does. A track with no measured words gets
 * times spread across each line by word length, which is arithmetic and not
 * evidence — the caller measures a re-cut track against the mix afterwards
 * (cueSync.ts), where the audio settles it.
 *
 * Lines merge only where both sides carry measured words. Authored lines — a
 * translation, a lyric sheet, narration written to picture — are somebody's
 * own breaks, so they are split when they run long and never glued together.
 */

import type { SubtitleCue } from "./types";

/** Words a caption holds when the project hasn't said otherwise. */
export const DEFAULT_WORDS_PER_CUE = 5;
export const MIN_WORDS_PER_CUE = 1;
export const MAX_WORDS_PER_CUE = 12;

/** A pause this long between two words breaks the caption, however few words
 * it holds: the speech stopped, so the line does too. */
const GAP = 0.6;
/** No caption holds the screen longer than this whatever the word count says.
 * One recognized "word" can be a whole line in a language written without
 * spaces, and five of those is a paragraph nobody can read. */
const MAX_SPAN = 6;
/** A caption never lands shorter than this. */
const MIN_SPAN = 0.2;
/** The end of a sentence ends the caption, closing quotes and brackets
 * included. */
const SENTENCE_END = /[.!?…。！？]["'”’)\]]?$/;

const round = (n: number) => Math.round(n * 1000) / 1000;
const uid = () => crypto.randomUUID().slice(0, 8);

/** The project's words-per-caption, clamped to what the UI offers. */
export function cueWordCount(subs: { wordsPerCue?: number }): number {
  const n = subs.wordsPerCue;
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_WORDS_PER_CUE;
  return Math.min(MAX_WORDS_PER_CUE, Math.max(MIN_WORDS_PER_CUE, Math.round(n)));
}

/** Spread a line's words across [start, end], each word's slice proportional
 * to its length. What a caption with no measured timings falls back to, here
 * and when captions are re-timed onto a generated voiceover. */
export function spreadWordsEvenly(
  text: string,
  start: number,
  end: number
): { t0: number; t1: number; w: string }[] | undefined {
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  const lengths = parts.map((w) => Math.max(1, w.length));
  const total = lengths.reduce((a, b) => a + b, 0);
  const span = Math.max(0, end - start);
  let acc = 0;
  return parts.map((w, i) => {
    const t0 = start + (acc / total) * span;
    acc += lengths[i];
    const t1 = start + (acc / total) * span;
    return { t0, t1, w };
  });
}

interface StreamWord {
  w: string;
  t0: number;
  t1: number;
  /** The transcriber measured this word. False means its time is a share of
   * the line it sits in, which is what keeps authored lines from merging. */
  measured: boolean;
  /** The cue it came from: its index in the track and its id, which the
   * caption it lands in reuses when it opens on the same word. */
  from: number;
  id: string;
}

/** One track's words in order, each carrying where it came from. Times are
 * kept monotonic, so a group's edges can be read straight off its ends. */
function streamOf(cues: readonly SubtitleCue[]): StreamWord[] {
  const out: StreamWord[] = [];
  let floor = -Infinity;
  cues.forEach((cue, from) => {
    const tokens = cue.text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return;
    // Word timings ride along only while they still describe the line: a
    // hand-edit that changed the word count left them behind, and the spread
    // is the honest reading then.
    const timed = cue.words && cue.words.length === tokens.length ? cue.words : null;
    const spread = timed ? null : spreadWordsEvenly(cue.text, cue.start, cue.end);
    tokens.forEach((w, i) => {
      const src = timed ? timed[i] : spread![i];
      const t0 = Math.max(src.t0, floor);
      const t1 = Math.max(src.t1, t0);
      floor = t1;
      out.push({ w, t0, t1, measured: !!timed, from, id: cue.id });
    });
  });
  return out;
}

/** The words cut into captions: `per` at most, and fewer wherever the speech,
 * the punctuation, or somebody's own line break says the caption ends. */
function groupsOf(stream: StreamWord[], per: number): StreamWord[][] {
  const out: StreamWord[][] = [];
  let cur: StreamWord[] = [];
  for (const word of stream) {
    const prev = cur[cur.length - 1];
    if (prev) {
      const authored = word.from !== prev.from && !(word.measured && prev.measured);
      if (
        cur.length >= per ||
        authored ||
        word.t0 - prev.t1 > GAP ||
        SENTENCE_END.test(prev.w) ||
        word.t1 - cur[0].t0 > MAX_SPAN
      ) {
        out.push(cur);
        cur = [];
      }
    }
    cur.push(word);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** One track's captions, re-cut to `per` words each. Cues come back in time
 * order, never overlapping, and a caption that opens on the word its old cue
 * opened on keeps that cue's id — so re-cutting a track at the number it
 * already carries leaves it exactly as it was. */
export function chunkLaneCues(cues: readonly SubtitleCue[], per: number): SubtitleCue[] {
  const n = cueWordCount({ wordsPerCue: per });
  const ordered = [...cues].sort((a, b) => a.start - b.start);
  const groups = groupsOf(streamOf(ordered), n);
  const lane = ordered[0]?.lane ?? 0;
  const used = new Set<string>();
  return groups.map((g, i) => {
    const first = g[0];
    const last = g[g.length - 1];
    const next = groups[i + 1]?.[0];
    const start = first.t0;
    // Captions on a track may never overlap, so a caption closes where the
    // next one opens whenever its own last word runs past it.
    const ceil = next ? Math.max(start, next.t0) : Infinity;
    const end = Math.min(Math.max(last.t1, start + MIN_SPAN), ceil);
    const id = used.has(first.id) ? uid() : first.id;
    used.add(id);
    const measured = g.every((w) => w.measured);
    return {
      id,
      start: round(start),
      end: round(end),
      text: g.map((w) => w.w).join(" "),
      ...(measured
        ? {
            words: g.map((w) => ({
              w: w.w,
              t0: round(Math.min(Math.max(w.t0, start), end)),
              t1: round(Math.min(Math.max(w.t1, start), end)),
            })),
          }
        : {}),
      ...(lane > 0 ? { lane } : {}),
    };
  });
}

/** Every track's captions re-cut to `per` words each, each track cut on its
 * own words. */
export function chunkCues(cues: readonly SubtitleCue[], per: number): SubtitleCue[] {
  if (cues.length === 0) return [];
  const lanes = new Map<number, SubtitleCue[]>();
  for (const cue of cues) {
    const lane = cue.lane ?? 0;
    const list = lanes.get(lane);
    if (list) list.push(cue);
    else lanes.set(lane, [cue]);
  }
  return [...lanes.values()]
    .flatMap((list) => chunkLaneCues(list, per))
    .sort((a, b) => a.start - b.start);
}
