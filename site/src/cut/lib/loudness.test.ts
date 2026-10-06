import { describe, expect, test } from "bun:test";
import {
  integratedFrom,
  kWeighting,
  LoudnessMeter,
  masterInPlace,
  masterPlan,
  measureLoudness,
  measureLoudnessSliced,
  TruePeakLimiter,
} from "./loudness";

const RATE = 48000;

/** A sine at `dbfs` peak, `seconds` long. */
const sine = (hz: number, dbfs: number, seconds: number, rate = RATE, phase = 0) => {
  const a = 10 ** (dbfs / 20);
  const n = Math.round(seconds * rate);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = a * Math.sin((2 * Math.PI * hz * i) / rate + phase);
  return x;
};
const concat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const stereo = (x: Float32Array) => [x, x.slice()];

/** The magnitude response of the two K-weighting stages at `hz`, in dB. */
const responseDb = (hz: number, rate: number) => {
  const w = (2 * Math.PI * hz) / rate;
  let mag = 1;
  for (const { b, a } of kWeighting(rate)) {
    const re = (c: number[]) => c[0] + c[1] * Math.cos(-w) + c[2] * Math.cos(-2 * w);
    const im = (c: number[]) => c[1] * Math.sin(-w) + c[2] * Math.sin(-2 * w);
    mag *= Math.hypot(re(b), im(b)) / Math.hypot(re(a), im(a));
  }
  return 20 * Math.log10(mag);
};

describe("K-weighting", () => {
  test("reproduces the coefficients BS.1770 prints for 48 kHz", () => {
    const [shelf, hp] = kWeighting(48000);
    const close = (got: number[], want: number[]) =>
      got.forEach((v, i) => expect(Math.abs(v - want[i])).toBeLessThan(1e-8));
    close(shelf.b, [1.53512485958697, -2.69169618940638, 1.19839281085285]);
    close(shelf.a, [1, -1.69065929318241, 0.73248077421585]);
    close(hp.b, [1, -2, 1]);
    close(hp.a, [1, -1.99004745483398, 0.99007225036621]);
  });

  test("has the curve's shape at any rate: flat-ish at 1 kHz, +4 dB high, rolled off low", () => {
    for (const rate of [44100, 48000, 96000]) {
      // −0.691 in the loudness formula cancels this gain.
      expect(Math.abs(responseDb(997, rate) - 0.691)).toBeLessThan(0.02);
      expect(Math.abs(responseDb(10000, rate) - 4)).toBeLessThan(0.3);
      expect(responseDb(20, rate)).toBeLessThan(-10);
    }
  });
});

describe("integrated loudness", () => {
  test("a full-scale 997 Hz sine in one channel reads −3.01 LUFS", () => {
    const x = sine(997, 0, 5);
    const m = measureLoudness([x, new Float32Array(x.length)], RATE);
    expect(Math.abs(m.integratedLufs - -3.01)).toBeLessThan(0.05);
  });

  test("a stereo 1 kHz sine at −23 dBFS reads −23 LUFS (EBU Tech 3341 case 1)", () => {
    const m = measureLoudness(stereo(sine(1000, -23, 20)), RATE);
    expect(Math.abs(m.integratedLufs - -23)).toBeLessThan(0.1);
  });

  test("a mono source weighted as the two channels it plays on reads as that stereo pair", () => {
    const x = sine(1000, -20, 10);
    const mono = new LoudnessMeter(RATE, 1, { weights: [2] });
    mono.push([x]);
    const pair = measureLoudness(stereo(x), RATE);
    expect(Math.abs(mono.result().integratedLufs - pair.integratedLufs)).toBeLessThan(0.01);
  });

  test("the sliced measurement matches the one-shot one", async () => {
    const x = stereo(concat(sine(1000, -18, 4), sine(440, -30, 3)));
    const whole = measureLoudness(x, RATE);
    const sliced = await measureLoudnessSliced(x, RATE);
    expect(sliced.integratedLufs).toBeCloseTo(whole.integratedLufs, 6);
    expect(sliced.truePeakDbtp).toBeCloseTo(whole.truePeakDbtp, 6);
  });

  test("reads the same at 44.1 kHz", () => {
    const m = measureLoudness(stereo(sine(1000, -33, 20, 44100)), 44100);
    expect(Math.abs(m.integratedLufs - -33)).toBeLessThan(0.1);
  });

  test("the relative gate drops the quiet passages (Tech 3341 case 3)", () => {
    const x = concat(sine(1000, -36, 10), sine(1000, -23, 60), sine(1000, -36, 10));
    expect(Math.abs(measureLoudness(stereo(x), RATE).integratedLufs - -23)).toBeLessThan(0.1);
  });

  test("both gates together (Tech 3341 case 4)", () => {
    const x = concat(
      sine(1000, -72, 10),
      sine(1000, -36, 10),
      sine(1000, -23, 60),
      sine(1000, -36, 10),
      sine(1000, -72, 10)
    );
    expect(Math.abs(measureLoudness(stereo(x), RATE).integratedLufs - -23)).toBeLessThan(0.1);
  });

  test("silence has no integrated loudness", () => {
    const m = measureLoudness(stereo(new Float32Array(RATE * 3)), RATE);
    expect(m.integratedLufs).toBe(-Infinity);
  });

  test("gating keeps blocks over the absolute gate and within 10 LU of their mean", () => {
    const p = (l: number) => 10 ** ((l + 0.691) / 10);
    // −80 is silence; −35 is 15 LU under the −20 block's mean; the mean of
    // what remains is the two −20 blocks.
    expect(integratedFrom([p(-80), p(-20), p(-35), p(-20)])).toBeCloseTo(-20, 6);
  });

  test("the answer does not depend on how the audio was chunked", () => {
    const x = concat(sine(440, -18, 3), sine(3000, -30, 2));
    const whole = measureLoudness(stereo(x), RATE);
    const meter = new LoudnessMeter(RATE, 2);
    for (let i = 0; i < x.length; i += 1013) meter.push(stereo(x.subarray(i, i + 1013)));
    const chunked = meter.result();
    expect(chunked.integratedLufs).toBeCloseTo(whole.integratedLufs, 9);
    expect(chunked.truePeakDbtp).toBeCloseTo(whole.truePeakDbtp, 9);
  });
});

describe("loudness range", () => {
  test("two halves 10 LU apart read about 10 LU (Tech 3342 case 1)", () => {
    const x = concat(sine(1000, -20, 20), sine(1000, -30, 20));
    expect(Math.abs(measureLoudness(stereo(x), RATE).loudnessRangeLu - 10)).toBeLessThan(1);
  });

  test("halves 20 LU apart read about 20 LU (Tech 3342 case 3)", () => {
    const x = concat(sine(1000, -40, 20), sine(1000, -20, 20));
    expect(Math.abs(measureLoudness(stereo(x), RATE).loudnessRangeLu - 20)).toBeLessThan(1);
  });
});

describe("true peak", () => {
  test("finds the peak between samples: a quarter-rate sine sampled at ±45°", () => {
    // Every sample sits at 0.707 of the waveform's peak, so the samples read
    // −3.01 dBFS while the signal reaches 0 dBTP.
    const x = sine(RATE / 4, -1, 1, RATE, Math.PI / 4);
    const m = measureLoudness(stereo(x), RATE);
    expect(m.samplePeakDbfs).toBeCloseTo(-4.01, 1);
    expect(m.truePeakDbtp).toBeGreaterThan(-1.2);
    expect(m.truePeakDbtp).toBeLessThan(-0.8);
  });

  test("equals the sample peak where the samples already carry it", () => {
    const m = measureLoudness(stereo(sine(997, -6, 1)), RATE);
    expect(Math.abs(m.truePeakDbtp - -6)).toBeLessThan(0.05);
  });

  test("catches a peak split across two chunks", () => {
    const x = sine(RATE / 4, 0, 0.01, RATE, Math.PI / 4);
    const meter = new LoudnessMeter(RATE, 1);
    meter.push([x.subarray(0, 241)]);
    meter.push([x.subarray(241)]);
    expect(meter.result().truePeakDbtp).toBeGreaterThan(-0.2);
  });
});

describe("mastering plan", () => {
  const measure = (integratedLufs: number, truePeakDbtp: number) => ({
    integratedLufs,
    truePeakDbtp,
    samplePeakDbfs: truePeakDbtp,
    loudnessRangeLu: 0,
    maxMomentaryLufs: integratedLufs,
    maxShortTermLufs: integratedLufs,
    seconds: 10,
  });

  test("one static gain to the target, no limiter when the peak stays under", () => {
    expect(masterPlan(measure(-20, -8), -14, -1)).toEqual({ gainDb: 6, limit: false, peakAfterGainDbtp: -2 });
  });

  test("limits only when the gained peak crosses the ceiling", () => {
    const plan = masterPlan(measure(-20, -4), -14, -1);
    expect(plan.gainDb).toBe(6);
    expect(plan.limit).toBe(true);
  });

  test("a mix that is too loud comes down, and needs no limiter", () => {
    const plan = masterPlan(measure(-9, 0.5), -14, -1);
    expect(plan.gainDb).toBe(-5);
    expect(plan.limit).toBe(false);
  });

  test("silence keeps its level", () => {
    expect(masterPlan(measure(-Infinity, -90), -14, -1).gainDb).toBe(0);
  });
});

describe("true-peak limiter", () => {
  const run = (input: Float32Array[], ceiling: number) => {
    const lim = new TruePeakLimiter(RATE, input.length, ceiling);
    const parts: Float32Array[][] = [];
    for (let i = 0; i < input[0].length; i += 4096) parts.push(lim.process(input.map((c) => c.subarray(i, i + 4096))));
    parts.push(lim.flush());
    return input.map((_, c) => concat(...parts.map((p) => p[c])));
  };

  test("holds the true peak under the ceiling, inter-sample overs included", () => {
    // A loud tone with quarter-rate bursts whose peaks fall between samples.
    const tone = sine(220, 3, 2);
    const burst = sine(RATE / 4, 4, 2, RATE, Math.PI / 4);
    const x = tone.map((v, i) => v + (Math.floor(i / 4800) % 3 === 0 ? burst[i] : 0));
    const out = run(stereo(Float32Array.from(x)), -1);
    expect(out[0].length).toBe(x.length);
    expect(measureLoudness(out, RATE).truePeakDbtp).toBeLessThanOrEqual(-1);
  });

  test("passes audio under the ceiling through untouched and aligned", () => {
    const x = sine(1000, -12, 0.5);
    const [out] = run([x], -1);
    expect(out.length).toBe(x.length);
    let worst = 0;
    for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(out[i] - x[i]));
    expect(worst).toBeLessThan(1e-6);
  });

  test("glides into a reduction instead of stepping: no sample changes gain abruptly", () => {
    const quiet = sine(100, -20, 0.5);
    const loud = sine(100, 0, 0.5);
    const x = concat(quiet, loud);
    const [out] = run([x], -6);
    // The gain at each pair of neighbouring samples, where it can be read
    // off the input.
    let jump = 0;
    for (let i = 1; i < x.length; i++) {
      if (Math.abs(x[i]) < 0.05 || Math.abs(x[i - 1]) < 0.05) continue;
      jump = Math.max(jump, Math.abs(out[i] / x[i] - out[i - 1] / x[i - 1]));
    }
    // A window of 5 ms at 48 kHz: the steepest step is the whole reduction
    // spread over 240 samples.
    expect(jump).toBeLessThan(0.005);
  });
});

describe("master in place", () => {
  test("lands a mix on the target with its true peak under the ceiling", async () => {
    // Speech-like: a tone that comes and goes, quiet overall with hot peaks.
    const x = new Float32Array(RATE * 6);
    for (let i = 0; i < x.length; i++) {
      const env = 0.5 + 0.5 * Math.sin((2 * Math.PI * i) / RATE);
      x[i] = 0.05 * env * Math.sin((2 * Math.PI * 300 * i) / RATE) + (i % 9600 < 200 ? 0.3 : 0) * Math.sin(i);
    }
    const channels = stereo(x);
    const report = await masterInPlace(channels, { sampleRate: RATE, targetLufs: -14, ceilingDbtp: -1 });
    const after = measureLoudness(channels, RATE);
    expect(report.plan.limit).toBe(true);
    expect(after.truePeakDbtp).toBeLessThanOrEqual(-1);
    // The limiter takes a little off the top of these hot bursts; the
    // integrated level lands within a unit of the target.
    expect(Math.abs(after.integratedLufs - -14)).toBeLessThan(1);
  });

  test("a clean gain when no limiting is needed", async () => {
    const channels = stereo(sine(1000, -30, 5));
    const report = await masterInPlace(channels, { sampleRate: RATE, targetLufs: -23, ceilingDbtp: -1 });
    expect(report.plan.limit).toBe(false);
    expect(Math.abs(measureLoudness(channels, RATE).integratedLufs - -23)).toBeLessThan(0.05);
  });
});
