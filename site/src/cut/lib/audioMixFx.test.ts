import { describe, expect, mock, test } from "bun:test";
import { AudioBuffer, OfflineAudioContext } from "node-web-audio-api";

// The fold runs on Web Audio, which Node has through the same package the
// headless runtime installs, and it reads its sources through `mediaRead` —
// stubbed here with a synthetic tone so the test is about the mix alone.
const RATE = 44100;
const SECONDS = 6;

const globals = globalThis as Record<string, unknown>;
globals.AudioBuffer ??= AudioBuffer;
globals.OfflineAudioContext ??= OfflineAudioContext;

const tone = () => {
  const buf = new AudioBuffer({
    length: SECONDS * RATE,
    numberOfChannels: 1,
    sampleRate: RATE,
  });
  const ch = buf.getChannelData(0);
  // A click every quarter second: a delay tap and a filter both show on it.
  for (let i = 0; i < ch.length; i++) {
    const phase = (i % (RATE / 4)) / (RATE / 4);
    ch[i] = phase < 0.02 ? Math.sin(2 * Math.PI * 900 * (i / RATE)) * (1 - phase / 0.02) : 0;
  }
  return buf;
};

mock.module("./mediaRead", () => ({ decodeAudioSpan: async () => tone() }));

const { renderMix } = await import("./audioMix");

const rms = (data: Float32Array, from: number, to: number) => {
  let sum = 0;
  const a = Math.floor(from * RATE);
  const b = Math.floor(to * RATE);
  for (let i = a; i < b; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / Math.max(1, b - a));
};

const fold = async (effects: { effect: string; amount?: number; start: number; end: number }[]) => {
  const buffer = await renderMix(
    {
      duration: SECONDS,
      clips: [{ file: "a.mp4", in: 0, out: SECONDS, muted: false }],
      items: [],
      effects,
    },
    { sampleRate: RATE, channels: 1, resolve: (f) => f }
  );
  expect(buffer).not.toBeNull();
  return buffer!.getChannelData(0);
};

describe("audio effects in the offline fold", () => {
  test("treats its own window and leaves the rest of the mix alone", async () => {
    const plain = await fold([]);
    const treated = await fold([{ effect: "echo", amount: 0.9, start: 2, end: 4 }]);
    // Outside the window the samples are the untreated mix, to the sample.
    expect(rms(treated, 0, 1.9)).toBeCloseTo(rms(plain, 0, 1.9), 5);
    expect(rms(treated, 4.2, 6)).toBeCloseTo(rms(plain, 4.2, 6), 5);
    // Inside it the echoes are audible.
    expect(rms(treated, 2.2, 3.8)).toBeGreaterThan(rms(plain, 2.2, 3.8) * 1.2);
  });

  test("a muffle takes the top off inside its window only", async () => {
    const plain = await fold([]);
    const treated = await fold([{ effect: "muffle", amount: 1, start: 1, end: 3 }]);
    expect(rms(treated, 4, 6)).toBeCloseTo(rms(plain, 4, 6), 5);
    // The clicks are 900 Hz transients and the muffle closes to 800 Hz, so
    // what is left inside the window is a different signal.
    const inside = rms(treated, 1.2, 2.8);
    expect(inside).toBeGreaterThan(0);
    expect(Math.abs(inside - rms(plain, 1.2, 2.8))).toBeGreaterThan(0.001);
  });

  test("two effects stack in series over their own stretches", async () => {
    const plain = await fold([]);
    const treated = await fold([
      { effect: "echo", amount: 0.9, start: 1, end: 2.5 },
      { effect: "crush", amount: 1, start: 3.5, end: 5 },
    ]);
    expect(rms(treated, 2.8, 3.4)).toBeCloseTo(rms(plain, 2.8, 3.4), 5);
    expect(rms(treated, 1.2, 2.3)).toBeGreaterThan(rms(plain, 1.2, 2.3) * 1.2);
    expect(Math.abs(rms(treated, 3.7, 4.8) - rms(plain, 3.7, 4.8))).toBeGreaterThan(0.001);
  });

  test("an effect the fold does not know leaves the mix as it was", async () => {
    const plain = await fold([]);
    const treated = await fold([{ effect: "grain", start: 1, end: 3 }]);
    expect(rms(treated, 0, SECONDS)).toBeCloseTo(rms(plain, 0, SECONDS), 5);
  });
});
