import { describe, expect, test } from "bun:test";
import { selectionCenter, selectionSummary, selectionTranslation, sharedNumber, sharedValue } from "./groupEdit";
import type { Overlay } from "./types";

describe("groupEdit", () => {
  test("a field agrees or reads as mixed", () => {
    expect(sharedValue(["a", "a"])).toEqual({ value: "a", mixed: false });
    expect(sharedValue(["a", "b"])).toEqual({ value: "a", mixed: true });
    expect(sharedNumber([1, 1])).toEqual({ value: 1, mixed: false });
    expect(sharedNumber([0, 1])).toEqual({ value: 0.5, mixed: true });
    expect(sharedNumber([])).toEqual({ value: 0, mixed: false });
  });

  test("the selection center is the middle of its span", () => {
    const c = selectionCenter([{ x: 0.2, y: 0.4 }, { x: 0.6, y: 0.8 }]);
    expect(c.x).toBeCloseTo(0.4);
    expect(c.y).toBeCloseTo(0.6);
  });

  test("a move keeps offsets and stops at the frame edge", () => {
    const items = [{ x: 0.2, y: 0.4 }, { x: 0.6, y: 0.8 }];
    const mid = selectionTranslation(items, { x: 0.5, y: 0.5 });
    expect(mid.dx).toBeCloseTo(0.1);
    expect(mid.dy).toBeCloseTo(-0.1);
    const edge = selectionTranslation(items, { x: 0.95, y: 0.95 });
    expect(0.6 + edge.dx).toBeCloseTo(0.98);
    expect(0.8 + edge.dy).toBeCloseTo(0.98);
  });

  test("grouped elements move across the camera's world", () => {
    const items = [{ x: 1.4, y: 0.5, groupId: "g" }, { x: 0.6, y: 0.5, groupId: "g" }];
    const right = selectionTranslation(items, { x: 1.1, y: 0.5 });
    expect(1.4 + right.dx).toBeCloseTo(1.5);
    const far = selectionTranslation(items, { x: 5, y: 0.5 });
    expect(1.4 + far.dx).toBeCloseTo(2);
  });

  test("the summary counts by kind", () => {
    const overlays = [
      { kind: "shape" } as Overlay, { kind: "shape" } as Overlay, { text: "hi" } as Overlay,
    ];
    expect(selectionSummary({ overlays, clips: [], audios: [] })).toBe("2 shapes · 1 title");
  });
});
