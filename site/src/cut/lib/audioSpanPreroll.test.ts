import { expect, test } from "bun:test";
import { AudioBuffer } from "node-web-audio-api";
import type { WrappedAudioBuffer } from "mediabunny";
import { decodeAudioSpan } from "./mediaRead";

(globalThis as { AudioBuffer?: unknown }).AudioBuffer ??= AudioBuffer;

// A compressed frame leans on the one before it (an MP3's bit reservoir, AAC's
// overlap), so the first frame a decode opens on comes out near-silent. A span
// whose decode opened on the frame holding its first sample lost that sample's
// sound: a click trimmed to just before its hit exported without the hit.

const RATE = 48000;
const FRAME = 1152 / RATE;

/** A decoder over a steady tone whose first decoded frame is silent. */
function framedDecoder(asked: number[]) {
  return async function* (_src: string | Blob, from = 0, to?: number): AsyncGenerator<WrappedAudioBuffer> {
    asked.push(from);
    let first = true;
    for (let k = Math.floor(from / FRAME); to === undefined || k * FRAME < to; k++) {
      if (k * FRAME > 2) return;
      const buffer = new AudioBuffer({ length: 1152, numberOfChannels: 1, sampleRate: RATE });
      buffer.getChannelData(0).fill(first ? 0 : 0.5);
      first = false;
      yield { buffer, timestamp: k * FRAME, duration: FRAME } as unknown as WrappedAudioBuffer;
    }
  };
}

test("a span decodes from before its start, so its first sample sounds", async () => {
  const asked: number[] = [];
  const out = (await decodeAudioSpan("x.mp3", 0.635, 0.9, framedDecoder(asked)))!;
  expect(asked[0]).toBeLessThan(0.635 - FRAME);
  const head = out.getChannelData(0).subarray(0, 480);
  expect(Math.min(...head)).toBeCloseTo(0.5, 5);
  expect(out.length).toBe(Math.round((0.9 - 0.635) * RATE));
});

test("a span at the file's start reads from 0", async () => {
  const asked: number[] = [];
  await decodeAudioSpan("x.mp3", 0.02, 0.5, framedDecoder(asked));
  expect(asked[0]).toBe(0);
});
