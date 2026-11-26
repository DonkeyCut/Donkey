import { describe, expect, test } from "bun:test";
import { blendPace, devicePace, estimateRenderMs, formatTimeEstimate, paceOf } from "./exportPace";

const timing = { frames: 900, spanSec: 30, audioMs: 500, prepareMs: 500, drawMs: 14_000, decodeMs: 6_000, encodeMs: 2_900, finalizeMs: 100 };
const hd = { width: 1080, height: 1920 };

describe("export pace", () => {
  test("a device with no renders yet gets an estimate from the starting pace", () => {
    expect(formatTimeEstimate(estimateRenderMs({ ...hd, fps: 30 }, 30, devicePace()), "en")).not.toBe("");
  });

  test("a render's pace predicts the same render's time", () => {
    const pace = paceOf(timing, hd)!;
    expect(estimateRenderMs({ ...hd, fps: 30 }, 30, pace)).toBeCloseTo(18_000, 5);
  });

  test("twice the frame rate and four times the pixels each scale the time", () => {
    const pace = paceOf(timing, hd)!;
    expect(estimateRenderMs({ ...hd, fps: 60 }, 30, pace)).toBeCloseTo(36_000, 5);
    expect(estimateRenderMs({ width: 2160, height: 3840, fps: 30 }, 30, pace)).toBeCloseTo(72_000, 5);
  });

  test("a render with no frames has no pace", () => {
    expect(paceOf({ ...timing, frames: 0 }, hd)).toBeNull();
  });

  test("the first render sets the pace and later ones blend in", () => {
    expect(blendPace(null, 8)).toBe(8);
    expect(blendPace(8, 4)).toBe(6);
  });
});

describe("formatTimeEstimate", () => {
  test("seconds round to five, minutes to one, hours to a tenth", () => {
    expect(formatTimeEstimate(2_000, "en")).toBe("~5 sec");
    expect(formatTimeEstimate(33_000, "en")).toBe("~35 sec");
    expect(formatTimeEstimate(59_000, "en")).toBe("~1 min");
    expect(formatTimeEstimate(758_000, "en")).toBe("~13 min");
    expect(formatTimeEstimate(5_400_000, "en")).toBe("~1.5 hr");
  });

  test("nothing to show for no time", () => {
    expect(formatTimeEstimate(0, "en")).toBe("");
  });
});
