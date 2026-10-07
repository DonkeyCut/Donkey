import { describe, expect, test } from "bun:test";
import {
  coarseSync,
  ENV_HOP_S,
  EnvelopeBuilder,
  envelopeOf,
  MonoResampler,
  SYNC_RATE,
  syncSound,
  type SyncChunk,
} from "./soundSync";

/** A seeded generator, so a failure replays. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Something with the shape of speech: bursts of tone and noise at random
 * levels, separated by pauses of random length. */
function speechLike(seconds: number, seed: number): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(Math.round(seconds * SYNC_RATE));
  let i = 0;
  while (i < out.length) {
    const burst = Math.round((0.08 + r() * 0.3) * SYNC_RATE);
    const level = 0.1 + r() * 0.8;
    const pitch = 90 + r() * 200;
    for (let k = 0; k < burst && i < out.length; k++, i++) {
      const env = Math.sin((Math.PI * k) / burst);
      out[i] = level * env * (0.6 * Math.sin((2 * Math.PI * pitch * i) / SYNC_RATE) + 0.4 * (r() * 2 - 1));
    }
    i += Math.round((0.03 + r() * 0.4) * SYNC_RATE);
  }
  return out;
}

/** The same room heard by another device: its own gain, its own hiss, and a
 * polarity of its choosing. */
function heardBy(signal: Float32Array, gain: number, noise: number, seed: number, flip = false): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = (flip ? -1 : 1) * gain * signal[i] + noise * (r() * 2 - 1);
  return out;
}

/** A file read the way the decoders hand it over: 48 kHz stereo, in chunks
 * that start wherever the read was asked to. `origin` is the file second the
 * signal's first sample sits at. */
const fileOf = (signal: Float32Array, origin = 0) => {
  let reads = 0;
  async function* read(from: number, to: number): AsyncGenerator<SyncChunk> {
    reads++;
    const lo = Math.max(0, Math.round((from - origin) * SYNC_RATE));
    const hi = Math.min(signal.length, Math.round((to - origin) * SYNC_RATE));
    for (let i = lo; i < hi; i += 1500) {
      const n = Math.min(1500, hi - i);
      const ch = new Float32Array(n * 3);
      for (let k = 0; k < n * 3; k++) ch[k] = signal[i + Math.floor(k / 3)];
      yield { channels: [ch, ch], timestamp: origin + i / SYNC_RATE, sampleRate: SYNC_RATE * 3 };
    }
  }
  return { read, reads: () => reads };
};

/** Both passes over two whole signals, each read from a file whose first
 * sample sits at the given second. */
const syncWhole = (camera: Float32Array, cameraStart: number, recording: Float32Array, recordingStart: number) =>
  syncSound(
    { camera: fileOf(camera, cameraStart).read, recording: fileOf(recording, recordingStart).read },
    {
      cameraFrom: cameraStart,
      cameraTo: cameraStart + camera.length / SYNC_RATE,
      recordingTo: recordingStart + recording.length / SYNC_RATE,
    }
  );

describe("syncSound over whole signals", () => {
  const room = speechLike(70, 7);

  test("finds where the camera's sound sits in the recording, to the sample", async () => {
    // The recorder rolled 12.345 s before the camera.
    const startAt = Math.round(12.345 * SYNC_RATE);
    const camera = heardBy(room.subarray(startAt, startAt + 30 * SYNC_RATE), 0.3, 0.01, 1);
    const recording = heardBy(room, 1, 0.002, 2);
    const answer = (await syncWhole(camera, 0, recording, 0))!;
    expect(answer).not.toBeNull();
    expect(Math.abs(answer.offset - 12.345)).toBeLessThan(1.5 / SYNC_RATE);
    expect(answer.refined).toBe(true);
    expect(answer.confidence).toBeGreaterThan(2);
  });

  test("a recording that started after the camera gives a negative offset", async () => {
    // Camera time 0 is recording time -4.5: the recorder rolled late.
    const camera = heardBy(room.subarray(0, 40 * SYNC_RATE), 0.5, 0.01, 3);
    const late = Math.round(4.5 * SYNC_RATE);
    const recording = heardBy(room.subarray(late), 1, 0.002, 4);
    const answer = (await syncWhole(camera, 0, recording, 0))!;
    expect(Math.abs(answer.offset - -4.5)).toBeLessThan(1.5 / SYNC_RATE);
  });

  test("source times carry through: a camera window late in its file, a recording window late in its", async () => {
    const startAt = Math.round(20 * SYNC_RATE);
    const camera = heardBy(room.subarray(startAt, startAt + 20 * SYNC_RATE), 0.4, 0.01, 5);
    const recording = heardBy(room.subarray(5 * SYNC_RATE), 1, 0.002, 6);
    // The camera window starts at camera second 100; the recording window at
    // recording second 5 of its file, which is room second 5. Camera second
    // 100 is room second 20, so recording = camera − 80.
    const answer = (await syncWhole(camera, 100, recording, 5))!;
    expect(Math.abs(answer.offset - -80)).toBeLessThan(1.5 / SYNC_RATE);
  });

  test("an inverted microphone still lines up", async () => {
    const startAt = Math.round(7.25 * SYNC_RATE);
    const camera = heardBy(room.subarray(startAt, startAt + 25 * SYNC_RATE), 0.2, 0.005, 7, true);
    const answer = (await syncWhole(camera, 0, heardBy(room, 1, 0.002, 8), 0))!;
    expect(Math.abs(answer.offset - 7.25)).toBeLessThan(1.5 / SYNC_RATE);
  });

  test("survives a noisy camera track", async () => {
    const startAt = Math.round(30.01 * SYNC_RATE);
    const camera = heardBy(room.subarray(startAt, startAt + 30 * SYNC_RATE), 0.3, 0.08, 9);
    const answer = (await syncWhole(camera, 0, heardBy(room, 1, 0.002, 10), 0))!;
    // Within a frame at 60 fps even if the fine pass gives up.
    expect(Math.abs(answer.offset - 30.01)).toBeLessThan(0.017);
    expect(answer.confidence).toBeGreaterThan(1.4);
  });

  test("two unrelated recordings have no clear peak", async () => {
    const camera = speechLike(30, 11);
    const recording = speechLike(70, 12);
    const answer = await syncWhole(camera, 0, recording, 0);
    expect(answer === null || answer.confidence < 1.4).toBe(true);
  });

  test("digital silence on either side has nothing to agree on", async () => {
    const answer = await syncWhole(new Float32Array(20 * SYNC_RATE), 0, room, 0);
    expect(answer === null || answer.confidence < 1.4).toBe(true);
  });
});

describe("coarseSync", () => {
  test("the lag is in envelope hops", () => {
    const room = speechLike(40, 21);
    const startAt = Math.round(10 * SYNC_RATE);
    const env = envelopeOf(room);
    const cam = envelopeOf(room.subarray(startAt, startAt + 15 * SYNC_RATE));
    const c = coarseSync(cam, env)!;
    expect(c.lag * ENV_HOP_S).toBeCloseTo(10, 1);
  });
});

describe("streaming pieces", () => {
  test("the resampler folds 48 kHz stereo to 16 kHz mono at the right length", () => {
    const r = new MonoResampler(1);
    const left = new Float32Array(48000).fill(0.5);
    const right = new Float32Array(48000).fill(-0.1);
    r.push([left.subarray(0, 20000), right.subarray(0, 20000)], 48000);
    r.push([left.subarray(20000), right.subarray(20000)], 48000);
    expect(Math.abs(r.samples().length - 16000)).toBeLessThanOrEqual(1);
    expect(r.samples()[100]).toBeCloseTo(0.2, 5);
  });

  test("the resampler keeps 44.1 kHz timing", () => {
    const r = new MonoResampler(2);
    r.push([new Float32Array(88200)], 44100);
    expect(Math.abs(r.samples().length - 32000)).toBeLessThanOrEqual(1);
  });

  test("the resampler raises a voice recorder's 8 kHz and 11.025 kHz to 16 kHz", () => {
    for (const rate of [8000, 11025]) {
      const r = new MonoResampler(1);
      // Two pushes, so a chunk boundary sits inside the stretch.
      r.push([new Float32Array(Math.floor(rate / 2)).fill(0.25)], rate);
      r.push([new Float32Array(Math.ceil(rate / 2)).fill(0.25)], rate);
      expect(Math.abs(r.samples().length - 16000)).toBeLessThanOrEqual(1);
      expect(r.samples()[15000]).toBeCloseTo(0.25, 5);
    }
  });

  test("an envelope built in pieces equals one built whole", () => {
    const room = speechLike(5, 31);
    const b = new EnvelopeBuilder(1);
    for (let i = 0; i < room.length; i += 777) b.push(room.subarray(i, i + 777));
    expect([...b.envelope()]).toEqual([...envelopeOf(room)]);
  });
});

describe("syncSound", () => {
  test("streams the recording and lands the offset on the sample", async () => {
    const room = speechLike(80, 41);
    // The recorder rolled 7.25 s before the camera; the camera's file is the
    // room from 7.25 on.
    const startAt = Math.round(7.25 * SYNC_RATE);
    const camera = fileOf(heardBy(room.subarray(startAt), 0.4, 0.01, 42));
    const recording = fileOf(heardBy(room, 1, 0.002, 43));
    const answer = (await syncSound(
      { camera: camera.read, recording: recording.read },
      { cameraFrom: 10, cameraTo: 40, recordingTo: 80 }
    ))!;
    expect(answer).not.toBeNull();
    expect(Math.abs(answer.offset - 7.25)).toBeLessThan(1.5 / SYNC_RATE);
    expect(answer.refined).toBe(true);
    // The whole recording once for its envelope, then the fine window.
    expect(recording.reads()).toBe(2);
  });

  test("an unrelated recording is not confident", async () => {
    const camera = fileOf(speechLike(40, 51));
    const recording = fileOf(speechLike(80, 52));
    const answer = await syncSound(
      { camera: camera.read, recording: recording.read },
      { cameraFrom: 0, cameraTo: 30, recordingTo: 80 }
    );
    expect(answer === null || answer.confidence < 1.4).toBe(true);
  });
});
