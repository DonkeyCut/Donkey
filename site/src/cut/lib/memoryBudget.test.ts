import { afterEach, describe, expect, test } from "bun:test";
import {
  allowance,
  canvasBytes,
  decodedFrameBytes,
  heapBytes,
  holdMemory,
  mb,
  memoryCeiling,
  memoryHolders,
  memoryUsage,
  takeMemoryPressure,
} from "./memoryBudget";

const MB = 2 ** 20;

const drops: (() => void)[] = [];
const hold = (holder: Parameters<typeof holdMemory>[0], bytes: number) => {
  drops.push(holdMemory(holder, () => bytes));
};

const holderNames = Object.keys(memoryHolders) as (keyof typeof memoryHolders)[];

afterEach(() => {
  for (const drop of drops.splice(0)) drop();
  takeMemoryPressure();
});

describe("the ceiling", () => {
  test("is a share of the machine", () => {
    // The environment the tests run in reports no `deviceMemory`, which is the
    // same silence Safari and Firefox give a real page: the assumed size
    // stands in, and an eighth of it is the tab's.
    expect(memoryCeiling()).toBe(2 ** 30);
    expect(memoryCeiling()).toBe(memoryCeiling());
  });

  test("splits a bucket between the holders that share it", () => {
    const huge = 99 * 2 ** 30;
    // The reads share is the chunk memory's and the readers' own caches',
    // half each, so the two of them together stand on the bucket and not
    // twice it.
    const half = Math.round(memoryCeiling() * 0.25 * 0.5);
    expect(allowance("chunkMemory", huge)).toBe(half);
    expect(allowance("readerCaches", huge)).toBe(half);
    expect(allowance("chunkMemory", huge) + allowance("readerCaches", huge)).toBe(
      Math.round(memoryCeiling() * 0.25)
    );
    // A tuning under the portion is still left alone.
    expect(allowance("readerCaches", 4 * MB)).toBe(4 * MB);
  });

  test("every holder of a bucket together ask for the whole of it, once", () => {
    // Nothing outside this table can hand a cache room, so a bucket whose
    // portions sum past one has promised memory twice, and a bucket that sums
    // under it is leaving room no one may use.
    const sums = new Map<string, number>();
    for (const name of holderNames) {
      const { bucket, portion } = memoryHolders[name];
      sums.set(bucket, (sums.get(bucket) ?? 0) + portion);
    }
    // Every bucket is stood in by someone, and the fractions come to one.
    expect([...sums.keys()].sort()).toEqual([
      "audio",
      "canvases",
      "decoders",
      "pictures",
      "reads",
    ]);
    for (const [, sum] of sums) expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  });

  test("hands a bucket the smaller of its tuning and its share", () => {
    // A size the machine can afford is left alone, so a preview tuned on a
    // machine with room behaves there exactly as it was tuned to.
    const small = 4 * MB;
    expect(allowance("previewDecoders", small)).toBe(small);
    expect(takeMemoryPressure()).toEqual([]);

    // A size it cannot is cut to the share, and the cut is recorded: the
    // machine is deciding, not the tuning.
    const huge = 99 * 2 ** 30;
    expect(allowance("previewDecoders", huge)).toBeLessThan(huge);
    expect(allowance("previewDecoders", huge)).toBe(Math.round(memoryCeiling() * 0.4));
    expect(takeMemoryPressure()).toEqual(["decoders"]);
    // Reading the pressure clears it, so a later window reports its own.
    expect(takeMemoryPressure()).toEqual([]);
  });

  test("splits the whole ceiling between the buckets and no more", () => {
    const huge = 99 * 2 ** 30;
    const shares = holderNames.reduce((n, name) => n + allowance(name, huge), 0);
    expect(shares).toBeLessThanOrEqual(memoryCeiling());
    expect(shares).toBeGreaterThan(memoryCeiling() * 0.99);
  });
});

describe("what is being held", () => {
  test("adds up what every cache reports, by bucket", () => {
    // Against what the modules loaded beside this one are already reporting:
    // every cache in the editor registers itself the moment it is imported.
    const before = memoryUsage();
    hold("previewDecoders", 10 * MB);
    hold("previewDecoders", 5 * MB);
    hold("chunkMemory", 3 * MB);
    const usage = memoryUsage();
    expect(mb(usage.decoders - before.decoders)).toBe(15);
    expect(mb(usage.reads - before.reads)).toBe(3);
    expect(mb(usage.canvases - before.canvases)).toBe(0);
    expect(mb(usage.total - before.total)).toBe(18);
  });

  test("forgets a cache that has been let go", () => {
    const before = memoryUsage().audio;
    hold("mixerAudio", 8 * MB);
    expect(mb(memoryUsage().audio - before)).toBe(8);
    drops.pop()!();
    expect(memoryUsage().audio).toBe(before);
  });

  test("reports nothing rather than guessing when the browser is silent", () => {
    // No `performance.memory` here, as in every browser but Chrome. A zero is
    // the honest answer; a made-up number would read as a measurement.
    expect(heapBytes()).toBe(0);
  });
});

describe("what a picture costs", () => {
  test("counts canvas backing at four bytes a pixel", () => {
    expect(canvasBytes(1920 * 1080)).toBe(1920 * 1080 * 4);
  });

  test("counts a decoded frame at the planar size the decoder hands back", () => {
    // Three halves of the luma plane: full-resolution luma, two quarter-
    // resolution chroma planes.
    expect(decodedFrameBytes(1920 * 1080)).toBe(Math.round(1920 * 1080 * 1.5));
  });

  test("a 4K decoder costs more than a 1080p one by the area", () => {
    expect(decodedFrameBytes(3840 * 2160)).toBe(decodedFrameBytes(1920 * 1080) * 4);
  });
});
