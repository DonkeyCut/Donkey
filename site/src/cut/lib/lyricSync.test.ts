import { describe, expect, test } from "bun:test";
import { alignWords, syncLines, type TimedWord } from "./lyricSync";

const heard = (pairs: [string, number, number][]): TimedWord[] =>
  pairs.map(([w, t0, t1]) => ({ w, t0, t1 }));

describe("alignWords", () => {
  test("matches through insertions and mishearings", () => {
    const a = ["i", "got", "half", "of", "my", "clients"];
    const b = ["uh", "i", "got", "hoff", "of", "my", "clients"];
    expect(alignWords(a, b)).toEqual([1, 2, -1, 4, 5, 6]);
  });

  test("nothing in common matches nothing", () => {
    expect(alignWords(["red", "blue"], ["cat", "dog"])).toEqual([-1, -1]);
  });
});

describe("syncLines", () => {
  test("lines take the times of the words the recognizer heard", () => {
    const lines = ["Hold on tight", "We're going home"];
    const words = heard([
      ["hold", 1, 1.4],
      ["on", 1.4, 1.8],
      ["tight", 1.8, 2.4],
      ["were", 3, 3.4],
      ["going", 3.4, 3.9],
      ["home", 3.9, 4.6],
    ]);
    const out = syncLines(lines, words, { from: 0, to: 6 });
    expect(out).toHaveLength(2);
    expect(out[0].start).toBeCloseTo(1, 2);
    expect(out[0].end).toBeCloseTo(2.4, 2);
    expect(out[1].start).toBeCloseTo(3, 2);
    expect(out[1].end).toBeCloseTo(4.6, 2);
  });

  test("the user's words are kept verbatim, whatever was heard", () => {
    const out = syncLines(["Don't stop believin'"], heard([
      ["dont", 2, 2.5],
      ["stop", 2.5, 3],
      ["believing", 3, 4],
    ]), { from: 0, to: 5 });
    expect(out[0].text).toBe("Don't stop believin'");
    expect(out[0].words?.map((w) => w.w)).toEqual(["Don't", "stop", "believin'"]);
  });

  test("words nobody heard are interpolated between the ones that were", () => {
    const out = syncLines(["one two three four"], heard([
      ["one", 0, 0.5],
      ["four", 3.5, 4],
    ]), { from: 0, to: 5 });
    const times = out[0].words!.map((w) => w.t0);
    expect(times[0]).toBeCloseTo(0, 2);
    expect(times[1]).toBeGreaterThan(0.5);
    expect(times[2]).toBeGreaterThan(times[1]);
    expect(times[3]).toBeCloseTo(3.5, 2);
  });

  test("lines stay in order, never overlap, and stay inside the span", () => {
    const out = syncLines(["a b", "c d", "e f"], heard([
      ["a", 9, 9.2],
      ["b", 1, 1.2],
      ["e", 4, 4.5],
    ]), { from: 0, to: 6 });
    for (let i = 0; i + 1 < out.length; i++) expect(out[i].end).toBeLessThanOrEqual(out[i + 1].start);
    expect(out[0].start).toBeGreaterThanOrEqual(0);
    expect(out[out.length - 1].end).toBeLessThanOrEqual(6);
  });

  test("a line whose end was never heard holds only as long as it reads", () => {
    // A short script against a long recording: the tail must not stretch to
    // the end of the source.
    const out = syncLines(["the opening line", "a line nobody heard"], heard([
      ["the", 1, 1.3],
      ["opening", 1.3, 1.8],
      ["line", 1.8, 2.2],
    ]), { from: 0, to: 600 });
    expect(out[1].end - out[1].start).toBeLessThan(4);
    expect(out[1].end).toBeLessThan(10);
  });

  test("a line crowded against the end of the span stays inside it", () => {
    const out = syncLines(["early", "late one"], heard([
      ["early", 0.2, 0.6],
      ["late", 5.9, 5.95],
      ["one", 5.95, 6],
    ]), { from: 0, to: 6 });
    for (const l of out) {
      expect(l.end).toBeLessThanOrEqual(6);
      expect(l.start).toBeGreaterThanOrEqual(0);
    }
  });

  test("a transcript with nothing recognizable still spreads the lines", () => {
    const out = syncLines(["first", "second", "third"], [], { from: 0, to: 9 });
    expect(out.map((l) => l.start)).toEqual([0, 3, 6]);
    expect(out[2].end).toBe(9);
  });
});
