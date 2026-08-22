import { describe, expect, mock, test } from "bun:test";
import { AudioBuffer, OfflineAudioContext } from "node-web-audio-api";

// The offline fold's side of a cross dissolve, on the Web Audio the headless
// runtime installs. Each clip reads back a steady tone of its own frequency,
// so the two are uncorrelated the way two shots are and the mix's level is
// the only thing the crossing can move.
const RATE = 44100;

const globals = globalThis as Record<string, unknown>;
globals.AudioBuffer ??= AudioBuffer;
globals.OfflineAudioContext ??= OfflineAudioContext;

const tone = (seconds: number, hz: number) => {
  const buf = new AudioBuffer({
    length: Math.max(1, Math.round(seconds * RATE)),
    numberOfChannels: 1,
    sampleRate: RATE,
  });
  const ch = buf.getChannelData(0);
  for (let i = 0; i < ch.length; i++) ch[i] = Math.sin((2 * Math.PI * hz * i) / RATE);
  return buf;
};

mock.module("./mediaRead", () => ({
  decodeAudioSpan: async (file: string, from: number, to: number) =>
    tone(to - from, file === "a.mp4" ? 440 : 880),
}));

const { renderMix } = await import("./audioMix");

const CUT = 4;

/** The mix of two four-second clips joined by a crossing that reaches
 * `handle` seconds into each clip's trimmed-away media. */
const crossed = async (half: number, handle: number) => {
  const buffer = await renderMix(
    {
      duration: 8,
      clips: [
        {
          file: "a.mp4",
          in: 1,
          out: 5,
          muted: false,
          soundCross: half,
          soundAhead: handle,
        },
        { file: "b.mp4", in: 1, out: 5, muted: false, soundBack: handle },
      ],
      items: [],
    },
    { sampleRate: RATE, channels: 1, resolve: (f) => f }
  );
  expect(buffer).not.toBeNull();
  return Float32Array.from(buffer!.getChannelData(0));
};

const level = (data: Float32Array, at: number) => {
  const a = Math.floor((at - 0.01) * RATE);
  const b = Math.floor((at + 0.01) * RATE);
  let sum = 0;
  for (let i = a; i < b; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / Math.max(1, b - a));
};

describe("a cross dissolve in the offline fold", () => {
  test("holds one level across the cut when both clips have handle", async () => {
    const mix = await crossed(0.4, 0.4);
    const steady = level(mix, 1);
    // Through the whole crossing the mix stays where it was: the two clips
    // are both sounding, and equal-power ramps keep their sum flat.
    for (const t of [CUT - 0.3, CUT - 0.1, CUT, CUT + 0.1, CUT + 0.3]) {
      expect(level(mix, t) / steady).toBeGreaterThan(0.9);
      expect(level(mix, t) / steady).toBeLessThan(1.1);
    }
    expect(level(mix, 7) / steady).toBeGreaterThan(0.9);
  });

  test("dips rather than empties when neither clip has handle", async () => {
    const mix = await crossed(0.4, 0);
    const steady = level(mix, 1);
    // Nothing to cross with, so the cut is the bottom of the ramps — but they
    // meet at equal power's half, not at silence.
    const middle = level(mix, CUT - 0.005) / steady;
    expect(middle).toBeGreaterThan(0.6);
    expect(middle).toBeLessThan(0.8);
  });
});
