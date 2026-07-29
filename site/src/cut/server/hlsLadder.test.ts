import { describe, expect, test } from "bun:test";

import { HLS_RUNGS, planLadder } from "./hlsLadder";

const shortSideOf = (r: { width: number; height: number }) => Math.min(r.width, r.height);

describe("ladder planning", () => {
  test("never upscales past the source", () => {
    for (const [w, h] of [
      [3840, 2160],
      [1920, 1080],
      [1280, 720],
      [640, 360],
      [1080, 1920], // portrait
      [1080, 1080], // square
    ] as const) {
      for (const rung of planLadder(w, h)) {
        expect(rung.width).toBeLessThanOrEqual(w);
        expect(rung.height).toBeLessThanOrEqual(h);
      }
    }
  });

  test("the top rung is the source itself", () => {
    const plan = planLadder(1920, 1080);
    const top = plan[plan.length - 1];
    expect(shortSideOf(top)).toBe(1080);
  });

  test("a small source gets exactly one rung", () => {
    // Below the lowest rung there is nothing to choose between, and a ladder of
    // one is still a valid stream.
    const plan = planLadder(426, 240);
    expect(plan).toHaveLength(1);
    expect(shortSideOf(plan[0])).toBe(240);
  });

  test("a 4K source gets the whole ladder", () => {
    expect(planLadder(3840, 2160)).toHaveLength(HLS_RUNGS.length);
  });

  test("rungs climb, so the master lists a real range to choose from", () => {
    const plan = planLadder(3840, 2160);
    for (let i = 1; i < plan.length; i++) {
      expect(shortSideOf(plan[i])).toBeGreaterThan(shortSideOf(plan[i - 1]));
      expect(plan[i].videoKbps).toBeGreaterThan(plan[i - 1].videoKbps);
    }
  });

  test("portrait and landscape ladder by the short side", () => {
    // A phone-shaped cut scaled by height would put its 360p rung at 202px
    // wide; the rung name has to mean the same thing in both orientations.
    const landscape = planLadder(1920, 1080);
    const portrait = planLadder(1080, 1920);
    expect(portrait.map(shortSideOf)).toEqual(landscape.map(shortSideOf));
    expect(portrait[0].width).toBe(360);
    expect(landscape[0].height).toBe(360);
  });

  test("every dimension is even, which the encoder requires", () => {
    for (const [w, h] of [
      [3840, 2160],
      [1080, 1920],
      [1440, 1080],
      [2048, 858], // cinemascope
    ] as const) {
      for (const rung of planLadder(w, h)) {
        expect(rung.width % 2).toBe(0);
        expect(rung.height % 2).toBe(0);
      }
    }
  });

  test("a wider frame at the same rung is given more bits", () => {
    // Bitrates are tuned for 16:9; an ultrawide frame carries more pixels at the
    // same short side and would otherwise be starved at every rung.
    const wide = planLadder(2560, 1080).find((r) => r.shortSide === 720);
    const normal = planLadder(1920, 1080).find((r) => r.shortSide === 720);
    expect(wide!.videoKbps).toBeGreaterThan(normal!.videoKbps);
  });

  test("aspect ratio survives every rung", () => {
    for (const [w, h] of [
      [1920, 1080],
      [1080, 1920],
      [2048, 858],
    ] as const) {
      for (const rung of planLadder(w, h)) {
        // Even-rounding moves each side by at most a pixel, so allow for that
        // rather than demanding the ratio match exactly.
        expect(Math.abs(rung.width / rung.height - w / h)).toBeLessThan(0.02);
      }
    }
  });
});
