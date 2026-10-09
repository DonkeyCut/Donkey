import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { masterRawMix } from "./exportAudio";

describe("masterRawMix", () => {
  test("pieces laid end to end master as the one mix they make", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cut-master-"));
    try {
      // Three seconds of stereo tone, split at a point that is not a whole
      // second, so a chunk straddles the two files.
      const rate = 48_000;
      const samples = new Float32Array(rate * 3 * 2);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = 0.2 * Math.sin((i >> 1) * 0.05);
      }
      const bytes = new Uint8Array(samples.buffer);
      const cut = 2 * 4 * 70_001;
      const [whole, a, b] = ["whole.f32", "a.f32", "b.f32"].map((f) => path.join(dir, f));
      await writeFile(whole, bytes);
      await writeFile(a, bytes.subarray(0, cut));
      await writeFile(b, bytes.subarray(cut));

      const opts = { sampleRate: rate, channels: 2, targetLufs: -16, ceilingDbtp: -1 };
      await masterRawMix([whole], path.join(dir, "one.f32"), opts);
      await masterRawMix([a, b], path.join(dir, "two.f32"), opts);
      const one = await readFile(path.join(dir, "one.f32"));
      expect(one.length).toBe(bytes.length);
      expect((await readFile(path.join(dir, "two.f32"))).equals(one)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
