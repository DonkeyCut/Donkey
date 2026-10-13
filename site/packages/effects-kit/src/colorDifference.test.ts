import { describe, expect, test } from "bun:test";
import { type Lab, deltaE2000 } from "./colorDifference";

describe("CIEDE2000", () => {
  // Pairs from Sharma, Wu and Dalal (2005), table 1, with their ΔE00.
  const PAIRS: [Lab, Lab, number][] = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.5, 0], [50, 0, -2.5], 4.3065],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[50, -0.001, 2.49], [50, 0.0009, -2.49], 4.8045],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
    [[90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239], 1.5381],
  ];
  for (const [p, q, want] of PAIRS) {
    test(`${p.join(",")} vs ${q.join(",")}`, () => {
      expect(Math.abs(deltaE2000(p, q) - want)).toBeLessThan(1e-4);
    });
  }
});
