import { describe, expect, test } from "bun:test";
import { bakesPixels, edgeMaxSeconds, evalOverlayAnim, OVERLAY_ANIM_MAX_SECONDS, TEXT_ONLY_ANIM_STYLE_IDS, type OverlayAnim } from "./anim";
import { countStep, countText } from "./count";
import { evalOverlayFrame } from "./keys";
import { elementAtMoment, planAnimatedLayers } from "./render";
import type { ShapeOverlay, TextOverlay } from "./types";

const title = (text: string, anim: OverlayAnim): TextOverlay => ({
  id: "t",
  text,
  start: 0,
  end: 5,
  x: 0.5,
  y: 0.5,
  size: 60,
  font: "sf",
  weight: 700,
  color: "#fff",
  plate: false,
  shadow: false,
  anim,
});

/** What the painter draws for `o` at `tLocal`. */
const drawnAt = (o: TextOverlay, tLocal: number): string =>
  (elementAtMoment(o, tLocal, evalOverlayFrame(o, tLocal)).el as TextOverlay).text;

describe("countText", () => {
  test("counts a percentage up from zero", () => {
    expect(countText("100 %", 0)).toBe("0 %");
    expect(countText("100 %", 0.5)).toBe("50 %");
    expect(countText("100 %", 1)).toBe("100 %");
  });

  test("keeps decimals, leading zeros and separators as written", () => {
    expect(countText("12.5", 0)).toBe("0.0");
    expect(countText("12.5", 0.5)).toBe("6.2");
    expect(countText("12.5", 1)).toBe("12.5");
    expect(countText("007", 0.5)).toBe("003");
    expect(countText("1,000 views", 0.5)).toBe("500 views");
    expect(countText("1,000 views", 1)).toBe("1,000 views");
  });

  test("leaves a title with no numbers unchanged", () => {
    expect(countText("Loading", 0)).toBe("Loading");
    expect(countText("Loading", 0.5)).toBe("Loading");
  });

  test("counts every number in the title at once", () => {
    expect(countText("3 of 10", 0.5)).toBe("1 of 5");
    expect(countText("3 of 10", 1)).toBe("3 of 10");
  });

  test("steps once per change in the shown text", () => {
    expect(countStep("100 %", 0)).toBe(0);
    expect(countStep("100 %", 0.5)).toBe(50);
    expect(countStep("3 of 10", 1)).toBe(13);
    expect(countStep("Loading", 1)).toBe(0);
  });
});

describe("the count entrance", () => {
  const anim: OverlayAnim = { in: { style: "count", seconds: 2 }, out: { style: "count", seconds: 1 } };

  test("is a text-only edge that bakes its pixels", () => {
    expect(TEXT_ONLY_ANIM_STYLE_IDS).toContain("count");
    expect(bakesPixels(anim.in, true)).toBe(true);
    expect(bakesPixels(anim.in, false)).toBe(false);
    expect(edgeMaxSeconds("count")).toBeGreaterThan(OVERLAY_ANIM_MAX_SECONDS);
    expect(edgeMaxSeconds("fade")).toBe(OVERLAY_ANIM_MAX_SECONDS);
  });

  test("counts up over the entrance, holds, and counts down on the exit", () => {
    const o = title("100 %", anim);
    expect(drawnAt(o, 0)).toBe("0 %");
    expect(Number(drawnAt(o, 1).split(" ")[0])).toBeGreaterThanOrEqual(49);
    expect(Number(drawnAt(o, 1).split(" ")[0])).toBeLessThanOrEqual(51);
    expect(drawnAt(o, 2.5)).toBe("100 %");
    expect(Number(drawnAt(o, 4.5).split(" ")[0])).toBeLessThan(60);
    expect(evalOverlayAnim(anim, 3, 5, true).countProgress).toBeUndefined();
  });

  test("leaves every other kind holding", () => {
    expect(evalOverlayAnim(anim, 1, 5, false).alpha).toBe(1);
    const shape = { ...title("", anim), kind: "shape" } as unknown as ShapeOverlay;
    expect(planAnimatedLayers(shape, 5).length).toBe(3);
  });

  test("the canvas plan draws one window per step, then the final value", () => {
    const o = title("10 %", { in: { style: "count", seconds: 2 } });
    const layers = planAnimatedLayers(o, 5);
    const texts = layers.map((l) => (l.overlay as TextOverlay).text);
    expect(texts.length).toBe(11);
    expect(texts[0]).toBe("0 %");
    expect(texts.at(-1)).toBe("10 %");
    expect(new Set(texts.slice(0, 10)).size).toBe(10);
  });
});
