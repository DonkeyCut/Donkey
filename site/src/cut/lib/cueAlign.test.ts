import { describe, expect, test } from "bun:test";
import { alignCues, speechSpans } from "./cueAlign";

/**
 * Cue alignment reads the audio it was transcribed from. These build that
 * audio: noise bursts where speech happens, quiet everywhere else, and cues
 * whose times are wrong in the ways transcribers get them wrong — a constant
 * lag, and edges that miss by a fraction of a second.
 */

const RATE = 16000;

/** A mix of `duration` seconds carrying a noise burst over each span. */
function mix(duration: number, spans: [number, number][]): Float32Array {
  const samples = new Float32Array(Math.round(duration * RATE));
  // A quiet, steady room tone under everything — the floor the envelope reads.
  let seed = 1;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
  for (let i = 0; i < samples.length; i++) samples[i] = rnd() * 0.002;
  for (const [from, to] of spans) {
    const start = Math.round(from * RATE);
    const stop = Math.min(samples.length, Math.round(to * RATE));
    for (let i = start; i < stop; i++) samples[i] += rnd() * 0.6;
  }
  return samples;
}

const cue = (start: number, end: number, text = "hello there") => ({
  id: `${start}`,
  start,
  end,
  text,
});

describe("speechSpans", () => {
  test("finds the bursts and skips the quiet", () => {
    const spans = speechSpans(mix(10, [[1, 2.5], [5, 7]]), RATE);
    expect(spans?.length).toBe(2);
    expect(spans![0].start).toBeCloseTo(1, 1);
    expect(spans![0].end).toBeCloseTo(2.5, 1);
    expect(spans![1].start).toBeCloseTo(5, 1);
  });

  test("has nothing to say about silence or a flat wall of sound", () => {
    expect(speechSpans(new Float32Array(RATE * 5), RATE)).toBe(null);
    expect(speechSpans(mix(6, [[0, 6]]), RATE)).toBe(null);
  });
});

describe("alignCues", () => {
  test("takes out a systematic lag", () => {
    const audio = mix(12, [[1, 2.5], [4, 5.5], [8, 9.5]]);
    // Every cue reported a quarter second late — the shape is right, the
    // placement is not.
    const late = [cue(1.25, 2.75), cue(4.25, 5.75), cue(8.25, 9.75)];
    const fixed = alignCues(late, audio, RATE);
    expect(fixed[0].start).toBeCloseTo(1, 1);
    expect(fixed[1].start).toBeCloseTo(4, 1);
    expect(fixed[2].end).toBeCloseTo(9.5, 1);
  });

  test("takes out a lag wider than any single edge may travel", () => {
    const audio = mix(14, [[1, 2.5], [4, 5.5], [8, 9.5], [11, 12.5]]);
    // 0.6s early, further than the per-edge snap window: only the global pass
    // can find this.
    const early = [cue(0.4, 1.9), cue(3.4, 4.9), cue(7.4, 8.9), cue(10.4, 11.9)];
    const fixed = alignCues(early, audio, RATE);
    expect(fixed[0].start).toBeCloseTo(1, 1);
    expect(fixed[3].start).toBeCloseTo(11, 1);
  });

  test("leaves cues that already sit on the speech", () => {
    const audio = mix(12, [[1, 2.5], [4, 5.5], [8, 9.5]]);
    const good = [cue(1, 2.5), cue(4, 5.5), cue(8, 9.5)];
    for (const [i, c] of alignCues(good, audio, RATE).entries()) {
      expect(c.start).toBeCloseTo(good[i].start, 1);
      expect(c.end).toBeCloseTo(good[i].end, 1);
    }
  });

  test("snaps each edge that misses on its own", () => {
    const audio = mix(12, [[1, 2.5], [4, 5.5], [8, 9.5]]);
    const off = [cue(1.14, 2.4), cue(3.86, 5.6), cue(8.2, 9.4)];
    const fixed = alignCues(off, audio, RATE);
    expect(fixed[0].start).toBeCloseTo(1, 1);
    expect(fixed[0].end).toBeCloseTo(2.5, 1);
    expect(fixed[1].start).toBeCloseTo(4, 1);
    expect(fixed[2].start).toBeCloseTo(8, 1);
  });

  test("carries word timings into the cue's new span", () => {
    const audio = mix(6, [[1, 2.5]]);
    const withWords = [
      {
        ...cue(1.25, 2.75),
        words: [
          { t0: 1.25, t1: 2.0, w: "hello" },
          { t0: 2.0, t1: 2.75, w: "there" },
        ],
      },
    ];
    const [fixed] = alignCues(withWords, audio, RATE);
    // The cue slid back onto the burst, and its words slid with it.
    expect(fixed.start).toBeCloseTo(1, 1);
    expect(fixed.words![0].t0).toBeCloseTo(fixed.start, 2);
    expect(fixed.words![1].t1).toBeCloseTo(fixed.end, 1);
    expect(fixed.words![0].t1).toBeGreaterThan(fixed.words![0].t0);
    for (const w of fixed.words!) {
      expect(w.t0).toBeGreaterThanOrEqual(fixed.start);
      expect(w.t1).toBeLessThanOrEqual(fixed.end);
    }
  });

  test("keeps cues in order and never overlaps them", () => {
    const audio = mix(12, [[1, 2.5], [2.7, 4], [8, 9.5]]);
    const packed = [cue(1.2, 2.6), cue(2.6, 4.2), cue(8.3, 9.3)];
    const fixed = alignCues(packed, audio, RATE);
    for (let i = 1; i < fixed.length; i++) {
      expect(fixed[i].start).toBeGreaterThanOrEqual(fixed[i - 1].end);
      expect(fixed[i].end).toBeGreaterThan(fixed[i].start);
    }
  });

  test("leaves the cues alone when the audio cannot answer", () => {
    const cues = [cue(1, 2.5), cue(4, 5.5)];
    expect(alignCues(cues, new Float32Array(RATE * 8), RATE)).toBe(cues);
    // Speech nowhere near the transcript: the overlap gate refuses the read.
    expect(alignCues(cues, mix(12, [[9, 11.5]]), RATE)).toBe(cues);
    expect(alignCues([], mix(6, [[1, 2]]), RATE)).toEqual([]);
  });

  test("reads 16-bit samples the same way as floats", () => {
    const floats = mix(12, [[1, 2.5], [4, 5.5], [8, 9.5]]);
    const ints = Int16Array.from(floats, (v) => Math.round(v * 32767));
    const late = [cue(1.25, 2.75), cue(4.25, 5.75), cue(8.25, 9.75)];
    expect(alignCues(late, ints, RATE)).toEqual(alignCues(late, floats, RATE));
  });
});
