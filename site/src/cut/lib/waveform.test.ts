import { describe, expect, test } from "bun:test";

import { foldPeaks, waveLevel, waveRef } from "./waveform";

const RATE = 48_000;

// A recording of key presses: room tone around -60 dBFS, each press a short
// click near -20 dBFS.
const ROOM = 0.001;
const PRESS = 0.1;

describe("foldPeaks", () => {
  test("catches a click on a single sample", () => {
    const peaks = new Array<number>(10).fill(0);
    const data = new Float32Array(RATE);
    data[4803] = -PRESS;
    foldPeaks(peaks, [data], 0, RATE, 1);
    expect(peaks[1]).toBeCloseTo(PRESS);
  });

  test("reads every channel", () => {
    const peaks = new Array<number>(10).fill(0);
    const left = new Float32Array(RATE);
    const right = new Float32Array(RATE);
    right[24_001] = PRESS;
    foldPeaks(peaks, [left, right], 0, RATE, 1);
    expect(peaks[5]).toBeCloseTo(PRESS);
  });

  test("places a chunk by its timestamp", () => {
    const peaks = new Array<number>(4).fill(0);
    const data = new Float32Array(RATE / 2);
    data[0] = PRESS;
    foldPeaks(peaks, [data], 1, RATE, 2);
    expect(peaks[2]).toBeCloseTo(PRESS);
    expect([peaks[0], peaks[1], peaks[3]]).toEqual([0, 0, 0]);
  });
});

describe("waveLevel", () => {
  test("draws a press tall and the room as a dot", () => {
    const peaks = [ROOM, PRESS * 0.4, ROOM, PRESS, ROOM];
    const ref = waveRef(peaks);
    expect(waveLevel(PRESS, ref)).toBeGreaterThan(0.9);
    expect(waveLevel(PRESS * 0.4, ref)).toBeGreaterThan(0.7);
    expect(waveLevel(ROOM, ref)).toBe(0);
  });

  test("keeps a strip of room tone low", () => {
    const ref = waveRef([ROOM * 3, ROOM]);
    expect(waveLevel(ROOM * 3, ref)).toBeLessThan(0.2);
  });

  test("draws silence flat", () => {
    expect(waveLevel(0, waveRef([0, 0]))).toBe(0);
  });
});
