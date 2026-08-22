import { describe, expect, test } from "bun:test";
import { AIR, MIN_AIR, placeEdge, REACH, settleJoint, type SpeechSegment } from "./cutRefine";

/**
 * Edges are placed against the words, so the take below is written as words:
 * a sentence, a long pause, a sentence, a breath, a sentence, and open air
 * either end. Each case asks where a model-made edge should really sit.
 */

const word = (start: number, end: number): SpeechSegment => ({ start, end, peakDb: -18 });

const take: SpeechSegment[] = [
  word(1, 4), // first sentence
  word(5, 9), // second, a second of pause before it
  word(9.3, 12), // third, only a breath before it
];
const bounds = { from: 0, to: 20 };

const near = (n: number) => Math.round(n * 1000) / 1000;

describe("out edges (a clip's end)", () => {
  test("an edge in the pause sits the pace's air past the last word", () => {
    expect(placeEdge(take, 4.8, "out", "natural", bounds)).toEqual({
      t: near(4 + AIR.natural.out),
      placed: true,
      bound: 4,
    });
  });

  test("an edge inside a word runs on until the word is whole", () => {
    expect(placeEdge(take, 3.6, "out", "natural", bounds).t).toBe(near(4 + AIR.natural.out));
  });

  test("pace changes the air and nothing else", () => {
    expect(placeEdge(take, 4.8, "out", "fast", bounds).t).toBe(near(4 + AIR.fast.out));
    expect(placeEdge(take, 4.8, "out", "relaxed", bounds).t).toBe(near(4 + AIR.relaxed.out));
  });

  test("a pause too short for the air stops clear of the next word", () => {
    // 0.3s of breath cannot hold a relaxed 0.45s tail, so the edge stops just
    // before the next word rather than eating its first syllable.
    const edge = placeEdge(take, 9.1, "out", "relaxed", bounds);
    expect(edge.t).toBeLessThan(9.3);
    expect(edge.t).toBeGreaterThanOrEqual(9 + MIN_AIR.out);
  });

  test("the fastest pace still lets the word finish", () => {
    const edge = placeEdge(take, 3.98, "out", "fast", bounds);
    expect(edge.t - 4).toBeGreaterThanOrEqual(MIN_AIR.out);
  });

  test("an edge out in open air pulls back to the last word", () => {
    expect(placeEdge(take, 13.5, "out", "natural", bounds).t).toBe(near(12 + AIR.natural.out));
  });

  test("no word within reach leaves the edge alone, flagged", () => {
    expect(placeEdge([word(1, 4)], 4 + REACH + 0.5, "out", "natural", bounds).placed).toBe(false);
  });

  test("with nothing after it the edge takes its full air", () => {
    expect(placeEdge([word(1, 4)], 4.1, "out", "relaxed", bounds).t).toBe(near(4 + AIR.relaxed.out));
  });
});

describe("in edges (a clip's start)", () => {
  test("an edge in the pause leads the next word by the pace's air", () => {
    expect(placeEdge(take, 4.2, "in", "natural", bounds)).toEqual({
      t: near(5 - AIR.natural.in),
      placed: true,
      bound: 5,
    });
  });

  test("an edge inside a word backs up so the word starts whole", () => {
    expect(placeEdge(take, 5.4, "in", "natural", bounds).t).toBe(near(5 - AIR.natural.in));
  });

  test("an edge at the source head trims the lead-in to the pace's air", () => {
    expect(placeEdge(take, 0, "in", "natural", bounds).t).toBe(near(1 - AIR.natural.in));
  });

  test("a breath too short for the air stops clear of the word before it", () => {
    const edge = placeEdge(take, 9.25, "in", "relaxed", bounds);
    expect(edge.t).toBeGreaterThan(9);
    expect(edge.t).toBeLessThanOrEqual(9.3 - MIN_AIR.in);
  });

  test("no word within reach leaves the edge alone, flagged", () => {
    expect(placeEdge([word(1, 4)], 1 - REACH - 0.5, "in", "natural", bounds).placed).toBe(false);
  });

  test("an edge past the last word has nothing to open on", () => {
    expect(placeEdge(take, 13, "in", "natural", bounds).placed).toBe(false);
  });
});

describe("a joint whose pause cannot hold both sides", () => {
  const out = { t: 4.26, placed: true, bound: 4 };
  const into = { t: 4.14, placed: true, bound: 4.3 };

  test("the two edges meet inside the pause", () => {
    const joint = settleJoint(out, into)!;
    expect(joint).toBeGreaterThanOrEqual(4 + Math.min(MIN_AIR.out, 0.3 * 0.6));
    expect(joint).toBeLessThanOrEqual(4.3 - Math.min(MIN_AIR.in, 0.3 * 0.4));
  });

  test("a pause of nothing at all still leaves each word whole", () => {
    const joint = settleJoint({ t: 4.1, placed: true, bound: 4 }, { t: 4.02, placed: true, bound: 4.06 })!;
    expect(joint).toBeGreaterThanOrEqual(4);
    expect(joint).toBeLessThanOrEqual(4.06);
  });

  test("words that overlap are not a pause, so there is no joint to settle", () => {
    expect(settleJoint({ t: 4.3, placed: true, bound: 4.3 }, { t: 4.1, placed: true, bound: 4.1 })).toBeNull();
  });
});
