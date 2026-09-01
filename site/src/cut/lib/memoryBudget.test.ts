import { afterEach, describe, expect, test } from "bun:test";
import {
  allowance,
  canvasBytes,
  decodedFrameBytes,
  heapBytes,
  holdMemory,
  mb,
  memoryCeiling,
  memoryUsage,
  takeMemoryPressure,
} from "./memoryBudget";

const MB = 2 ** 20;

const drops: (() => void)[] = [];
const hold = (bucket: Parameters<typeof holdMemory>[0], bytes: number) => {
  drops.push(holdMemory(bucket, () => bytes));
};

afterEach(() => {
  for (const drop of drops.splice(0)) drop();
  takeMemoryPressure();
});

describe("the ceiling", () => {
  test("is a share of the machine, decided once", () => {
    // The environment the tests run in reports no `deviceMemory`, which is the
    // same silence Safari and Firefox give a real page: the assumed size
    // stands in, and a quarter of it is the tab's.
    expect(memoryCeiling()).toBe(2 * 2 ** 30);
    expect(memoryCeiling()).toBe(memoryCeiling());
  });

  test("hands a bucket the smaller of its tuning and its share", () => {
    // A size the machine can afford is left alone, so a preview tuned on a
    // machine with room behaves there exactly as it was tuned to.
    const small = 4 * MB;
    expect(allowance("decoders", small)).toBe(small);
    expect(takeMemoryPressure()).toEqual([]);

    // A size it cannot is cut to the share, and the cut is recorded: the
    // machine is deciding, not the tuning.
    const huge = 99 * 2 ** 30;
    expect(allowance("decoders", huge)).toBeLessThan(huge);
    expect(allowance("decoders", huge)).toBe(Math.round(memoryCeiling() * 0.4));
    expect(takeMemoryPressure()).toEqual(["decoders"]);
    // Reading the pressure clears it, so a later window reports its own.
    expect(takeMemoryPressure()).toEqual([]);
  });

  test("splits the whole ceiling between the buckets and no more", () => {
    const huge = 99 * 2 ** 30;
    const shares =
      allowance("decoders", huge) +
      allowance("canvases", huge) +
      allowance("reads", huge) +
      allowance("audio", huge) +
      allowance("pictures", huge);
    expect(shares).toBeLessThanOrEqual(memoryCeiling());
    expect(shares).toBeGreaterThan(memoryCeiling() * 0.99);
  });
});

describe("what is being held", () => {
  test("adds up what every cache reports, by bucket", () => {
    hold("decoders", 10 * MB);
    hold("decoders", 5 * MB);
    hold("reads", 3 * MB);
    const usage = memoryUsage();
    expect(mb(usage.decoders)).toBe(15);
    expect(mb(usage.reads)).toBe(3);
    expect(mb(usage.canvases)).toBe(0);
    expect(mb(usage.total)).toBe(18);
  });

  test("forgets a cache that has been let go", () => {
    hold("audio", 8 * MB);
    expect(mb(memoryUsage().audio)).toBe(8);
    drops.pop()!();
    expect(memoryUsage().audio).toBe(0);
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
