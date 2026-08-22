import { describe, expect, test } from "bun:test";
import { AudioBuffer, OfflineAudioContext } from "node-web-audio-api";
import { AUDIO_EFFECT_IDS, audioFxRecipe, buildAudioFx } from "./audioFx";

/**
 * What the recipes have to be: audible.
 *
 * An effect whose numbers are right and whose sound is a small change nobody
 * notices is a broken tile — it was placed, it renders, and it does nothing a
 * listener can hear. These render each effect at the strength a drop places
 * (no amount set) over a speech-shaped signal and hold it to a floor: the
 * output has to differ from the untreated signal by more than a level trim,
 * and each effect has to differ in its own direction.
 */

const globals = globalThis as Record<string, unknown>;
globals.AudioBuffer ??= AudioBuffer;
globals.OfflineAudioContext ??= OfflineAudioContext;

const RATE = 44100;
const SECONDS = 1.5;
/** The harmonics the test voice is built from, low to high. */
const HARMONICS = [150, 300, 600, 1200, 2400, 4800, 9000];

/** A voice-shaped signal: a harmonic series under a syllable envelope, with a
 * little noise on top so the filters have something to take off. */
function voice(): AudioBuffer {
  const buf = new AudioBuffer({
    length: Math.round(SECONDS * RATE),
    numberOfChannels: 1,
    sampleRate: RATE,
  });
  const ch = buf.getChannelData(0);
  let seed = 3;
  const noise = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 2147483648 - 1);
  for (let i = 0; i < ch.length; i++) {
    const t = i / RATE;
    const syllable = Math.max(0, Math.sin(Math.PI * ((t * 3) % 1)));
    let v = 0;
    let a = 1;
    for (const hz of HARMONICS) {
      v += a * Math.sin(2 * Math.PI * hz * t);
      a *= 0.62;
    }
    ch[i] = (v / 2.3 + noise() * 0.05) * syllable * 0.5;
  }
  return buf;
}

const SOURCE = voice();

async function render(effect: string | null): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.round(SECONDS * RATE), RATE);
  const node = ctx.createBufferSource();
  node.buffer = SOURCE;
  if (effect) {
    const chain = buildAudioFx(ctx, audioFxRecipe(effect)!, 0);
    node.connect(chain.input);
    chain.output.connect(ctx.destination);
  } else {
    node.connect(ctx.destination);
  }
  node.start();
  // Copied out: the rendering's channel data is a view the next render is free
  // to write over, and the untreated take has to survive the treated ones.
  return Float32Array.from((await ctx.startRendering()).getChannelData(0));
}

const rms = (d: Float32Array, from = 0, to = d.length) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += d[i] * d[i];
  return Math.sqrt(sum / Math.max(1, to - from));
};

/** The level at one frequency, by the Goertzel sum — an FFT bin without the
 * FFT, which is all a handful of harmonics needs. */
const levelAt = (d: Float32Array, hz: number) => {
  const w = (2 * Math.PI * hz) / RATE;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < d.length; i++) {
    const s = d[i] + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return Math.sqrt(Math.abs(s1 * s1 + s2 * s2 - c * s1 * s2)) / d.length;
};

const dB = (x: number) => 20 * Math.log10(Math.max(1e-12, x));

/** How much of the treated signal is not the untreated one, in decibels,
 * after matching the levels — so an effect cannot pass on makeup gain alone. */
function change(wet: Float32Array, dry: Float32Array): number {
  const k = rms(dry) / Math.max(1e-9, rms(wet));
  let sum = 0;
  for (let i = 0; i < wet.length; i++) sum += (wet[i] * k - dry[i]) ** 2;
  return dB(Math.sqrt(sum / wet.length) / rms(dry));
}

/** The swing an amplitude modulation puts on the level, in decibels. */
function swing(d: Float32Array): number {
  const w = Math.round(RATE * 0.015);
  const env: number[] = [];
  for (let i = 0; i + w < d.length; i += w) env.push(rms(d, i, i + w));
  const peak = Math.max(...env);
  const loud = env.filter((v) => v > 0.02 * peak).sort((a, b) => a - b);
  if (loud.length < 8) return 0;
  return dB(loud[loud.length - 1]) - dB(loud[Math.floor(loud.length * 0.15)]);
}

describe("every audio effect is audible at the strength a drop places", () => {
  test("each one changes the sound by more than a level trim", async () => {
    const dry = await render(null);
    for (const id of AUDIO_EFFECT_IDS) {
      const wet = await render(id);
      // −26 dB is around where a change stops being a detail and starts being
      // the point; every effect clears it with room to spare.
      expect({ id, change: change(wet, dry) > -26 }).toEqual({ id, change: true });
    }
  });

  test("each one moves the sound in the direction its name promises", async () => {
    const dry = await render(null);
    const band = async (id: string) => {
      const wet = await render(id);
      const at = (hz: number) => dB(levelAt(wet, hz)) - dB(levelAt(dry, hz));
      return { low: at(150), mid: at(1200), high: at(4800) };
    };

    // Muffle and telephone take the top off; the phone takes the bottom too.
    const muffle = await band("muffle");
    expect(muffle.high).toBeLessThan(-20);
    expect(muffle.low).toBeGreaterThan(0);
    const telephone = await band("telephone");
    expect(telephone.low).toBeLessThan(-20);
    expect(telephone.mid).toBeGreaterThan(3);

    // Deep leans into the body and loses the detail; bright does the reverse.
    const deep = await band("deep");
    expect(deep.low).toBeGreaterThan(4);
    expect(deep.high).toBeLessThan(-4);
    const bright = await band("bright");
    expect(bright.high).toBeGreaterThan(4);
    expect(bright.low).toBeLessThan(-4);

    // A wobble that only grazes the level is heard as nothing at all.
    expect(swing(await render("wobble")) - swing(dry)).toBeGreaterThan(4);
  });

  test("the rooms are still sounding after the sound that made them stops", async () => {
    // A burst, then silence: a reverb tail and an echo repeat both live in
    // the silence, which is the part a spectrum of the whole take cannot show.
    const burst = new AudioBuffer({
      length: Math.round(SECONDS * RATE),
      numberOfChannels: 1,
      sampleRate: RATE,
    });
    const ch = burst.getChannelData(0);
    for (let i = 0; i < 0.3 * RATE; i++) {
      const t = i / RATE;
      let v = 0;
      let a = 1;
      for (const hz of [180, 360, 720, 1440, 2880]) {
        v += a * Math.sin(2 * Math.PI * hz * t);
        a *= 0.6;
      }
      ch[i] = (v / 2.2) * 0.5 * Math.min(1, (0.3 - t) * 20);
    }
    const tail = async (id: string) => {
      const ctx = new OfflineAudioContext(1, Math.round(SECONDS * RATE), RATE);
      const node = ctx.createBufferSource();
      node.buffer = burst;
      const chain = buildAudioFx(ctx, audioFxRecipe(id)!, 0);
      node.connect(chain.input);
      chain.output.connect(ctx.destination);
      node.start();
      const out = Float32Array.from((await ctx.startRendering()).getChannelData(0));
      const body = rms(out, 0, Math.round(0.3 * RATE));
      return dB(rms(out, Math.round(0.35 * RATE), Math.round(0.9 * RATE)) / body);
    };
    // Half a second after the burst, a room is still ringing well above the
    // floor, and an echo is repeating louder still.
    expect(await tail("reverb")).toBeGreaterThan(-30);
    expect(await tail("echo")).toBeGreaterThan(-18);
  });
});
