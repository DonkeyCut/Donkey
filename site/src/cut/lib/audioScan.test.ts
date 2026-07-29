import { describe, expect, test } from "bun:test";
import { scanSilence, type PcmChunk } from "./audioScan";

const RATE = 8000;

/** One mono chunk from a level-per-second script: `1` is a full-scale tone,
 * `0` is digital silence. Chunks are split at `every` seconds so a scan can be
 * fed the same audio in different spans. */
async function* chunks(levels: number[], every = 1): AsyncGenerator<PcmChunk> {
  const total = levels.length * RATE;
  const per = Math.round(every * RATE);
  for (let start = 0; start < total; start += per) {
    const length = Math.min(per, total - start);
    const data = new Float32Array(length);
    for (let i = 0; i < length; i++) data[i] = levels[Math.floor((start + i) / RATE)];
    yield { channels: [data], timestamp: start / RATE, sampleRate: RATE };
  }
}

const opts = { from: 0, thresholdDb: -30, minSilence: 0.5 };

describe("scanSilence", () => {
  test("finds a silent stretch between two loud ones", async () => {
    const found = await scanSilence(chunks([1, 0, 0, 1]), opts);
    expect(found).toHaveLength(1);
    expect(found[0].start).toBeCloseTo(1, 1);
    expect(found[0].end).toBeCloseTo(3, 1);
    expect(found[0].duration).toBeCloseTo(2, 1);
  });

  test("reports nothing for audio that is loud throughout", async () => {
    expect(await scanSilence(chunks([1, 1, 1]), opts)).toEqual([]);
  });

  test("reports the whole span when nothing is above the threshold", async () => {
    const found = await scanSilence(chunks([0, 0, 0]), opts);
    expect(found).toHaveLength(1);
    expect(found[0].start).toBeCloseTo(0, 1);
    expect(found[0].end).toBeCloseTo(3, 1);
  });

  test("drops runs shorter than minSilence", async () => {
    // A tenth of a second of silence, well under the half-second floor.
    const levels = new Float32Array(RATE * 2).fill(1);
    levels.fill(0, RATE, RATE + RATE / 10);
    const one: PcmChunk = { channels: [levels], timestamp: 0, sampleRate: RATE };
    expect(await scanSilence((async function* () { yield one; })(), opts)).toEqual([]);
  });

  test("closes a silence that runs to the end of the audio", async () => {
    const found = await scanSilence(chunks([1, 0, 0]), opts);
    expect(found).toHaveLength(1);
    expect(found[0].start).toBeCloseTo(1, 1);
    expect(found[0].end).toBeCloseTo(3, 1);
  });

  test("reads the same silences however the chunks are split", async () => {
    const levels = [1, 0, 0, 0, 1, 1, 0, 0, 1];
    const whole = await scanSilence(chunks(levels, 9), opts);
    const bySecond = await scanSilence(chunks(levels, 1), opts);
    // 0.037s does not divide the window, so spans land mid-window here.
    const ragged = await scanSilence(chunks(levels, 0.037), opts);
    expect(bySecond).toEqual(whole);
    expect(ragged).toEqual(whole);
  });

  test("honours from/to, clamping the reported span to the range", async () => {
    const found = await scanSilence(chunks([1, 0, 0, 0, 1]), { ...opts, from: 1.5, to: 3.5 });
    expect(found).toHaveLength(1);
    expect(found[0].start).toBeCloseTo(1.5, 1);
    expect(found[0].end).toBeCloseTo(3.5, 1);
  });

  test("measures across every channel, so one loud side is not silence", async () => {
    const quiet = new Float32Array(RATE * 2);
    const loud = new Float32Array(RATE * 2).fill(1);
    const stereo: PcmChunk = { channels: [quiet, loud], timestamp: 0, sampleRate: RATE };
    expect(await scanSilence((async function* () { yield stereo; })(), opts)).toEqual([]);
  });

  test("has nothing to say about no audio at all", async () => {
    expect(await scanSilence((async function* (): AsyncGenerator<PcmChunk> {})(), opts)).toEqual([]);
  });
});
