import { describe, expect, test } from "bun:test";

import { logGamma, normalCdf, probabilityBeats, sampleSizePerArm, twoProportionTest } from "./stats";

describe("stats", () => {
  test("normal cdf at known points", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 5);
    expect(normalCdf(-1.959964)).toBeCloseTo(0.025, 5);
  });

  test("log gamma matches factorials", () => {
    expect(Math.exp(logGamma(5))).toBeCloseTo(24, 6);
    expect(Math.exp(logGamma(1))).toBeCloseTo(1, 9);
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 9);
  });

  test("two-proportion test", () => {
    const same = twoProportionTest(50, 500, 50, 500);
    expect(same.diff).toBe(0);
    expect(same.pValue).toBeCloseTo(1, 6);
    const better = twoProportionTest(50, 500, 80, 500);
    expect(better.relativeLift).toBeCloseTo(0.6, 9);
    expect(better.pValue!).toBeLessThan(0.01);
    expect(twoProportionTest(0, 100, 0, 100).pValue).toBeNull();
    expect(twoProportionTest(0, 0, 1, 10).pValue).toBeNull();
  });

  test("probability of beating the control", () => {
    expect(probabilityBeats(50, 500, 50, 500)).toBeCloseTo(0.5, 2);
    expect(probabilityBeats(50, 500, 80, 500)).toBeGreaterThan(0.99);
    expect(probabilityBeats(80, 500, 50, 500)).toBeLessThan(0.01);
    // Symmetric: P(B > A) + P(A > B) = 1 for continuous posteriors.
    expect(probabilityBeats(3, 40, 7, 40) + probabilityBeats(7, 40, 3, 40)).toBeCloseTo(1, 6);
    expect(probabilityBeats(0, 0, 0, 0)).toBeCloseTo(0.5, 6);
  });

  test("sample size per arm", () => {
    // 5% control, 20% relative lift: about 8.2k per arm at α .05, power .8.
    const n = sampleSizePerArm(0.05, 0.2)!;
    expect(n).toBeGreaterThan(8000);
    expect(n).toBeLessThan(8400);
    expect(sampleSizePerArm(0, 0.2)).toBeNull();
    expect(sampleSizePerArm(0.9, 0.2)).toBeNull();
  });
});
