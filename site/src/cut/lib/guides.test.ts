import { describe, expect, test } from "bun:test";
import { guideGeometry, guideSnapLines, safeAreaOf, sanitizeGuideLines, sanitizeGuides } from "./guides";

describe("guides", () => {
  test("sanitizeGuides keeps known ids once, in registry order", () => {
    expect(sanitizeGuides(["shortform", "nope", "thirds", "shortform"])).toEqual(["thirds", "shortform"]);
    expect(sanitizeGuides(undefined)).toEqual([]);
  });

  test("platform zones apply to portrait frames only", () => {
    expect(guideGeometry(["shortform"], "9:16").boxes.length).toBe(5);
    expect(guideGeometry(["shortform"], "16:9").boxes.length).toBe(0);
    expect(guideGeometry(["thirds"], "16:9").v).toEqual([1 / 3, 2 / 3]);
  });

  test("the safe area is the frame minus every keep-out band and rail", () => {
    const safe = safeAreaOf(["shortform"], "9:16")!;
    expect(safe.x).toBeGreaterThan(0.04);
    expect(safe.y).toBeGreaterThan(0.1);
    expect(safe.x + safe.w).toBeLessThan(0.84);
    expect(safe.y + safe.h).toBeLessThan(0.77);
    expect(safeAreaOf(["thirds", "center"], "9:16")).toBeNull();
    expect(safeAreaOf(["margins"], "16:9")).toEqual({ x: 0.05, y: 0.05, w: 0.9, h: 0.9 });
  });

  test("custom lines draw and snap only while the custom set is on", () => {
    const lines = { v: [0.2], h: [0.7] };
    expect(guideGeometry(["custom"], "16:9", lines).custom).toEqual(lines);
    expect(guideGeometry(["thirds"], "16:9", lines).custom).toEqual({ v: [], h: [] });
    expect(guideSnapLines(["custom"], "16:9", lines).v).toEqual([0.2]);
    expect(sanitizeGuideLines({ v: [1.4, "x", -0.2], h: null })).toEqual({ v: [1, 0], h: [] });
  });

  test("snap lines carry drawn lines and the inner edge of every box", () => {
    const lines = guideSnapLines(["center", "shortform"], "9:16");
    expect(lines.v.includes(0.5)).toBe(true);
    expect(lines.h.includes(0.5)).toBe(true);
    expect(lines.h.length).toBe(3);
    expect(lines.v.length).toBe(4);
  });
});
