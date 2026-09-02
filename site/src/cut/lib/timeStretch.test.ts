import { describe, expect, test } from "bun:test";
import { timeStretch } from "./timeStretch";

const RATE = 16000;

/** A pure tone, so pitch is something a test can measure. */
function sine(hz: number, seconds: number, rate = RATE): Float32Array {
  const data = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * hz * i) / rate);
  return data;
}

/**
 * Dominant frequency by zero crossings, measured over the interior only — the
 * first and last half-frame are windowed down, and counting crossings through
 * near-silence would report noise rather than the tone.
 */
function pitchOf(data: Float32Array, rate = RATE): number {
  const from = Math.floor(data.length * 0.25);
  const to = Math.floor(data.length * 0.75);
  let crossings = 0;
  for (let i = from + 1; i < to; i++) {
    if (data[i - 1] <= 0 && data[i] > 0) crossings++;
  }
  return crossings / ((to - from) / rate);
}

describe("timeStretch", () => {
  test("measures its own fixture correctly", () => {
    expect(pitchOf(sine(440, 1))).toBeCloseTo(440, -1);
  });

  test("halves the length of a clip played at double speed", () => {
    const [out] = timeStretch([sine(440, 1)], RATE, 0.5);
    expect(out.length).toBe(RATE / 2);
  });

  test("doubles the length of a clip played at half speed", () => {
    const [out] = timeStretch([sine(440, 1)], RATE, 2);
    expect(out.length).toBe(RATE * 2);
  });

  test("keeps the pitch when it compresses", () => {
    const [out] = timeStretch([sine(440, 1)], RATE, 0.5);
    // Resampling instead would put this an octave up, at 880.
    expect(pitchOf(out)).toBeCloseTo(440, -1);
  });

  test("keeps the pitch when it expands", () => {
    const [out] = timeStretch([sine(440, 1)], RATE, 2);
    // Resampling instead would put this an octave down, at 220.
    expect(pitchOf(out)).toBeCloseTo(440, -1);
  });

  test("keeps the pitch at the speeds an editor actually uses", () => {
    for (const speed of [1.25, 1.5, 2, 0.5, 0.75]) {
      const [out] = timeStretch([sine(300, 1.5)], RATE, 1 / speed);
      expect(pitchOf(out)).toBeCloseTo(300, -1);
      expect(out.length).toBe(Math.round((1.5 * RATE) / speed));
    }
  });

  test("passes audio through untouched at speed 1", () => {
    const input = sine(440, 0.5);
    const [out] = timeStretch([input], RATE, 1);
    expect(out.length).toBe(input.length);
    expect(Array.from(out.slice(0, 64))).toEqual(Array.from(input.slice(0, 64)));
  });

  test("cuts every channel at the same points, so stereo stays put", () => {
    // Identical channels must come back identical: choosing offsets per channel
    // would slide them against each other and smear the image.
    const left = sine(440, 1);
    const right = sine(440, 1);
    const [outL, outR] = timeStretch([left, right], RATE, 0.5);
    expect(Array.from(outL)).toEqual(Array.from(outR));
  });

  test("keeps silence silent", () => {
    const [out] = timeStretch([new Float32Array(RATE)], RATE, 0.5);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  test("holds its amplitude rather than fading through the middle", () => {
    const [out] = timeStretch([sine(440, 1)], RATE, 0.5);
    const interior = out.subarray(Math.floor(out.length * 0.25), Math.floor(out.length * 0.75));
    let peak = 0;
    for (const v of interior) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.9);
  });

  test("survives audio too short to frame", () => {
    const tiny = sine(440, 0.005);
    const [out] = timeStretch([tiny], RATE, 0.5);
    expect(out.length).toBe(Math.round(tiny.length * 0.5));
  });

  test("returns the input unchanged for a nonsense factor", () => {
    const input = sine(440, 0.1);
    expect(timeStretch([input], RATE, 0)[0].length).toBe(input.length);
    expect(timeStretch([input], RATE, NaN)[0].length).toBe(input.length);
  });

  test("has nothing to do with no channels", () => {
    expect(timeStretch([], RATE, 0.5)).toEqual([]);
  });
});

describe("timeStretch with a schedule", () => {
  test("lays a varying factor to the integral of the schedule, at pitch", () => {
    // 1 s at 1×, then 1 s at half speed: 3 s out.
    const [out] = timeStretch([sine(300, 2)], RATE, {
      factorAt: (sec) => (sec < 1 ? 1 : 2),
    });
    expect(out.length).toBe(RATE * 3);
    expect(pitchOf(out)).toBeCloseTo(300, -1);
  });

  test("honours the caller's output length", () => {
    const [out] = timeStretch([sine(300, 2)], RATE, {
      factorAt: (sec) => 1 + sec / 2,
      outLength: 12345,
    });
    expect(out.length).toBe(12345);
  });
});
