import { describe, expect, test } from "bun:test";
import { chunkCues, cueWordCount, DEFAULT_WORDS_PER_CUE } from "./cueChunk";
import type { SubtitleCue } from "./types";

/**
 * Cutting a caption track to a word count.
 *
 * What these hold: the wording survives a re-cut word for word, the edges land
 * on the words the transcriber measured, captions never overlap, and lines
 * somebody wrote by hand are split but never glued together.
 */

/** A transcribed cue: every word measured, a word every 0.4s. */
function heard(id: string, from: number, text: string): SubtitleCue {
  const parts = text.split(" ");
  return {
    id,
    start: from,
    end: from + parts.length * 0.4,
    text,
    words: parts.map((w, i) => ({ w, t0: from + i * 0.4, t1: from + i * 0.4 + 0.35 })),
  };
}

/** An authored line: text and a span, no measured words. */
const written = (id: string, start: number, end: number, text: string): SubtitleCue => ({
  id,
  start,
  end,
  text,
});

const wordsOf = (cues: SubtitleCue[]) => cues.flatMap((c) => c.text.split(" "));

describe("cueWordCount", () => {
  test("defaults, and clamps what the project carries", () => {
    expect(cueWordCount({})).toBe(DEFAULT_WORDS_PER_CUE);
    expect(cueWordCount({ wordsPerCue: 3 })).toBe(3);
    expect(cueWordCount({ wordsPerCue: 0 })).toBe(1);
    expect(cueWordCount({ wordsPerCue: 99 })).toBe(12);
  });
});

describe("chunkCues", () => {
  test("cuts a transcribed line into groups of n, keeping every word", () => {
    const cues = [heard("a", 1, "Don't wait for someone to give you a chance")];
    const out = chunkCues(cues, 5);
    expect(out.map((c) => c.text)).toEqual(["Don't wait for someone to", "give you a chance"]);
    expect(wordsOf(out)).toEqual(wordsOf(cues));
  });

  test("edges are the words' own times", () => {
    const out = chunkCues([heard("a", 1, "one two three four five six")], 3);
    expect(out[0].start).toBeCloseTo(1, 3);
    expect(out[0].end).toBeCloseTo(2.15, 3);
    expect(out[1].start).toBeCloseTo(2.2, 3);
    expect(out[1].words?.map((w) => w.w)).toEqual(["four", "five", "six"]);
  });

  test("merges across measured lines when the words keep running", () => {
    const out = chunkCues([heard("a", 1, "one two"), heard("b", 1.8, "three four")], 4);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("one two three four");
    expect(out[0].id).toBe("a");
  });

  test("a pause in the speech closes the caption early", () => {
    const out = chunkCues([heard("a", 1, "one two"), heard("b", 6, "three four")], 5);
    expect(out.map((c) => c.text)).toEqual(["one two", "three four"]);
  });

  test("a finished sentence closes the caption early", () => {
    const out = chunkCues([heard("a", 1, "so that's it. now watch this")], 6);
    expect(out.map((c) => c.text)).toEqual(["so that's it.", "now watch this"]);
  });

  test("authored lines split but never merge", () => {
    const cues = [
      written("a", 0, 2, "no esperes a que alguien te dé una oportunidad"),
      written("b", 2, 3, "hazlo tú"),
    ];
    const out = chunkCues(cues, 5);
    expect(out.map((c) => c.text)).toEqual([
      "no esperes a que alguien",
      "te dé una oportunidad",
      "hazlo tú",
    ]);
    // Times are a share of the line they came from, and nothing crosses into
    // the line beside it.
    expect(out[1].end).toBeLessThanOrEqual(2);
    expect(out[2].start).toBeGreaterThanOrEqual(2);
    // No measured words, so none are written — the word effect falls back to
    // its own share of the span.
    expect(out[0].words).toBeUndefined();
  });

  test("captions on a track never overlap, and stay in order", () => {
    const out = chunkCues(
      [heard("a", 1, "one two three four five six seven eight nine ten")],
      2
    );
    for (let i = 0; i + 1 < out.length; i++) {
      expect(out[i].end).toBeLessThanOrEqual(out[i + 1].start);
      expect(out[i].end).toBeGreaterThan(out[i].start);
    }
  });

  test("each track is cut on its own words", () => {
    const out = chunkCues(
      [
        heard("a", 1, "one two three four"),
        { ...heard("b", 1, "uno dos tres cuatro"), lane: 1 },
      ],
      2
    );
    expect(out.filter((c) => (c.lane ?? 0) === 0).map((c) => c.text)).toEqual([
      "one two",
      "three four",
    ]);
    expect(out.filter((c) => c.lane === 1).map((c) => c.text)).toEqual([
      "uno dos",
      "tres cuatro",
    ]);
  });

  test("re-cutting at the number a track already carries changes nothing", () => {
    const once = chunkCues([heard("a", 1, "one two three four five six seven")], 4);
    const twice = chunkCues(once, 4);
    expect(twice).toEqual(once);
  });

  test("a caption never holds the screen for more than a few seconds", () => {
    // A language written without spaces: the whole line is one "word".
    const cues = [
      written("a", 0, 4, "很长的一句话"),
      written("b", 4, 8, "另一句话"),
      written("c", 8, 12, "第三句话"),
    ];
    const out = chunkCues(cues, 5);
    for (const c of out) expect(c.end - c.start).toBeLessThanOrEqual(6.001);
  });

  test("a hand-edited line that lost its word count falls back to the spread", () => {
    const cue = { ...heard("a", 1, "one two three four"), text: "one two three" };
    const out = chunkCues([cue], 2);
    expect(out.map((c) => c.text)).toEqual(["one two", "three"]);
    expect(out[0].words).toBeUndefined();
    expect(out[0].start).toBeCloseTo(1, 3);
    expect(out[out.length - 1].end).toBeCloseTo(2.6, 3);
  });
});
