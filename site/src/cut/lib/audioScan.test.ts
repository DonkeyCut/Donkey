import { describe, expect, test } from "bun:test";
import { scanSilence, scanSpeech, type PcmChunk } from "./audioScan";

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

// ── Speech ──────────────────────────────────────────────────────────────────

/** Deterministic noise: a scan that passes four times in five is no test. */
const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648 - 0.5;
};

interface Spoken {
  start: number;
  end: number;
  /** Peak amplitude, so a whispered aside can sit under a shouted line. */
  level?: number;
}

/**
 * A take: bursts shaped like words — attack, hold, decay, a wobble inside —
 * over a room. `floorDb` is the room, `bedDb` lays a steady tone under
 * everything, the case where nothing is ever truly quiet.
 */
async function* take(
  words: Spoken[],
  opts: { floorDb: number; bedDb?: number; duration: number; seed?: number }
): AsyncGenerator<PcmChunk> {
  const rate = 16000;
  const rnd = rng(opts.seed ?? 7);
  const out = new Float32Array(Math.ceil(opts.duration * rate));
  const floor = Math.pow(10, opts.floorDb / 20);
  for (let i = 0; i < out.length; i++) out[i] = rnd() * floor * 2;
  if (opts.bedDb !== undefined) {
    const bed = Math.pow(10, opts.bedDb / 20);
    for (let i = 0; i < out.length; i++) out[i] += Math.sin((2 * Math.PI * 110 * i) / rate) * bed;
  }
  for (const w of words) {
    const from = Math.round(w.start * rate);
    const to = Math.min(out.length, Math.round(w.end * rate));
    const len = Math.max(1, to - from);
    for (let i = from; i < to; i++) {
      const p = (i - from) / len;
      const env = Math.min(1, p / 0.1) * Math.min(1, (1 - p) / 0.15);
      const wobble = 0.7 + 0.3 * Math.sin(p * Math.PI * 4);
      out[i] += rnd() * (w.level ?? 0.6) * env * wobble;
    }
  }
  // Handed over in uneven spans, the way a decoder hands them over.
  for (let start = 0; start < out.length; start += 4321) {
    const end = Math.min(out.length, start + 4321);
    yield { channels: [out.slice(start, end)], timestamp: start / rate, sampleRate: rate };
  }
}

const SPOKEN: Spoken[] = [
  { start: 0.6, end: 1.4 },
  { start: 1.6, end: 2.5 },
  { start: 3.4, end: 4.2 },
];

/** Every word accounted for, each within `slack` of where it was spoken. */
function expectWords(
  segments: { start: number; end: number }[],
  words: Spoken[],
  slack: { early: number; late: number }
) {
  expect(segments).toHaveLength(words.length);
  words.forEach((w, i) => {
    // A word may be opened early and closed late — never the other way round,
    // which is the cut landing inside it.
    expect(segments[i].start).toBeLessThanOrEqual(w.start + 0.02);
    expect(segments[i].start).toBeGreaterThanOrEqual(w.start - slack.early);
    expect(segments[i].end).toBeGreaterThanOrEqual(w.end - 0.02);
    expect(segments[i].end).toBeLessThanOrEqual(w.end + slack.late);
  });
}

describe("scanSpeech", () => {
  test("finds the words in a quiet room", async () => {
    const scan = await scanSpeech(take(SPOKEN, { floorDb: -60, duration: 5 }), { from: 0 });
    expect(scan.separated).toBe(true);
    expectWords(scan.segments, SPOKEN, { early: 0.12, late: 0.2 });
  });

  test("finds the same words in a room 22dB louder", async () => {
    const scan = await scanSpeech(take(SPOKEN, { floorDb: -38, duration: 5 }), { from: 0 });
    expect(scan.separated).toBe(true);
    expectWords(scan.segments, SPOKEN, { early: 0.12, late: 0.2 });
  });

  test("finds them in a quiet recording nobody normalized", async () => {
    const quiet = SPOKEN.map((w) => ({ ...w, level: 0.05 }));
    const scan = await scanSpeech(take(quiet, { floorDb: -78, duration: 5 }), { from: 0 });
    expectWords(scan.segments, quiet, { early: 0.12, late: 0.2 });
  });

  test("reads the gaps under a steady music bed", async () => {
    const scan = await scanSpeech(take(SPOKEN, { floorDb: -60, bedDb: -34, duration: 5 }), { from: 0 });
    expect(scan.segments.length).toBe(SPOKEN.length);
  });

  test("keeps a word whole across the closure inside it", async () => {
    // "sta-p": 40ms of nothing in the middle of one word is not a pause.
    const scan = await scanSpeech(
      take([{ start: 1, end: 1.4 }, { start: 1.44, end: 1.7 }], { floorDb: -60, duration: 3 }),
      { from: 0 }
    );
    expect(scan.segments).toHaveLength(1);
    expect(scan.segments[0].end).toBeGreaterThan(1.65);
  });

  test("a click is not a word", async () => {
    const scan = await scanSpeech(
      take([{ start: 1, end: 1.02, level: 0.9 }, { start: 2, end: 2.6 }], { floorDb: -60, duration: 3.5 }),
      { from: 0 }
    );
    expect(scan.segments).toHaveLength(1);
    expect(scan.segments[0].start).toBeGreaterThan(1.5);
  });

  test("a room with nothing said in it holds no words", async () => {
    const scan = await scanSpeech(take([], { floorDb: -60, duration: 3 }), { from: 0 });
    expect(scan.segments).toEqual([]);
  });

  test("hears the same words however the range is windowed", async () => {
    const whole = await scanSpeech(take(SPOKEN, { floorDb: -50, duration: 5 }), { from: 0 });
    const part = await scanSpeech(take(SPOKEN, { floorDb: -50, duration: 5 }), { from: 3, to: 5 });
    const last = whole.segments[whole.segments.length - 1];
    expect(part.segments).toHaveLength(1);
    expect(part.segments[0].start).toBeCloseTo(last.start, 1);
    expect(part.segments[0].end).toBeCloseTo(last.end, 1);
  });
});
