import { describe, expect, test } from "bun:test";

import { SETTINGS } from "@/lib/config/registry";
import { highlightCandidates, rankOf, sentences } from "./highlights";

const settings = SETTINGS.cutClip.default;
const seg = (start: number, end: number, text: string) => ({ start, end, text });

describe("sentences", () => {
  test("a sentence that ends inside a segment is cut where it ends", () => {
    // A recognizer hands back "…even 50s. I mean, there's a" as one segment.
    // Folding that whole thing into one unit gives a clip that opens or closes
    // mid-thought, so the break has to happen inside it.
    const units = sentences(
      [seg(0, 4, "There is a resurgence of the experienced founder. I mean"), seg(4, 8, "there is a lot of it.")],
      settings.pauseBreakSeconds,
    );
    expect(units.map((u) => u.text)).toEqual([
      "There is a resurgence of the experienced founder.",
      "I mean there is a lot of it.",
    ]);
  });

  test("the break takes its time from where it falls in the words", () => {
    // The first sentence is most of a four-second segment, so it ends near
    // the end of it, never at the segment boundary.
    const [first, second] = sentences([seg(0, 4, "A long first sentence here. Short.")], 0.6);
    expect(first.start).toBe(0);
    expect(first.end).toBeGreaterThan(2.5);
    expect(first.end).toBeLessThan(4);
    expect(second.end).toBe(4);
  });

  test("a pause ends a unit even with nothing to punctuate it", () => {
    const units = sentences([seg(0, 2, "no punctuation here"), seg(9, 11, "and this is later")], 0.6);
    expect(units.length).toBe(2);
  });

  test("a decimal point is not a sentence", () => {
    const [only] = sentences([seg(0, 4, "It went from 4.5% to 10% of the batch.")], 0.6);
    expect(only.text).toBe("It went from 4.5% to 10% of the batch.");
  });

  test("segments with no text and no length drop", () => {
    expect(sentences([seg(0, 0, "zero length"), seg(1, 2, "   ")], 0.6)).toEqual([]);
  });
});

describe("highlightCandidates", () => {
  // Forty sentences of five seconds each: a source long enough to stride.
  const talk = Array.from({ length: 40 }, (_, i) => seg(i * 5, i * 5 + 5, `Sentence ${i} of the talk.`));

  test("candidates open on a sentence and run inside the bounds", () => {
    const cands = highlightCandidates(talk, settings);
    expect(cands.length).toBeGreaterThan(2);
    for (const c of cands) {
      expect(c.to - c.from).toBeGreaterThanOrEqual(settings.minSeconds);
      expect(c.to - c.from).toBeLessThanOrEqual(settings.maxSeconds);
      expect(talk.some((u) => Math.abs(u.start - c.from) < 0.05)).toBe(true);
    }
  });

  test("starts sit at least a stride apart", () => {
    const starts = highlightCandidates(talk, settings).map((c) => c.from);
    for (let i = 1; i < starts.length; i++)
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(settings.strideSeconds);
  });

  test("a source shorter than one clip offers nothing", () => {
    expect(highlightCandidates([seg(0, 6, "Too short to clip.")], settings)).toEqual([]);
  });
});

describe("rankOf", () => {
  const h = { from: 0, to: 30, text: "", standalone: 1, hook: 0, payoff: 0 };

  test("the composite rides the settings' weights", () => {
    const only = { ...settings, standaloneWeight: 1, hookWeight: 0, payoffWeight: 0 };
    expect(rankOf(h, only)).toBe(1);
    expect(rankOf({ ...h, standalone: 0, hook: 1 }, only)).toBe(0);
  });

  test("weights that sum to nothing rank nothing", () => {
    expect(rankOf(h, { ...settings, standaloneWeight: 0, hookWeight: 0, payoffWeight: 0 })).toBe(0);
  });
});
