import { describe, expect, test } from "bun:test";
import { isOverlayAnimated } from "./keys";
import {
  behindSubjectMask,
  hasMaskKeys,
  isMaskAnimated,
  maskFrameAt,
  maskKeyAt,
  restingMaskFrame,
  type Mask,
  type MaskKey,
} from "./mask";

const mask = (over: Partial<Mask> = {}): Mask => ({ kind: "rect", ...over });
const key = (t: number, over: Partial<MaskKey> = {}): MaskKey => ({
  t,
  x: 0,
  y: 0,
  w: 0.5,
  h: 0.5,
  rotation: 0,
  feather: 0,
  ...over,
});

describe("mask frames", () => {
  test("no keys resolves to the resting geometry with defaults filled", () => {
    expect(maskFrameAt(mask(), 1)).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5, rotation: 0, feather: 0, radius: 0 });
    expect(restingMaskFrame(mask({ x: 0.1, feather: 24, radius: 8 }))).toEqual({
      x: 0.1,
      y: 0,
      w: 0.5,
      h: 0.5,
      rotation: 0,
      feather: 24,
      radius: 8,
    });
  });

  test("a key without a radius falls back to the mask's own, and keyed radii blend", () => {
    const m = mask({ radius: 10, kf: [key(0), key(2, { radius: 30 })] });
    expect(maskFrameAt(m, 0).radius).toBe(10);
    expect(maskFrameAt(m, 1).radius).toBe(20);
    expect(maskFrameAt(m, 2).radius).toBe(30);
  });

  test("geometry moves between keys and holds outside them", () => {
    const m = mask({ kf: [key(1, { w: 0.2 }), key(3, { w: 0.8, feather: 40 })] });
    expect(maskFrameAt(m, 0).w).toBeCloseTo(0.2);
    expect(maskFrameAt(m, 2).w).toBeCloseTo(0.5);
    expect(maskFrameAt(m, 2).feather).toBeCloseTo(20);
    expect(maskFrameAt(m, 9).w).toBeCloseTo(0.8);
  });

  test("rotation takes the short way around", () => {
    const m = mask({ kf: [key(0, { rotation: -170 }), key(2, { rotation: 170 })] });
    expect(maskFrameAt(m, 1).rotation).toBeCloseTo(-180);
  });

  test("a new key captures the live geometry, so adding one changes nothing", () => {
    const m = mask({ kf: [key(0, { x: -0.2 }), key(4, { x: 0.3 })] });
    const mid = maskKeyAt(m, 2);
    const after = { ...m, kf: [...m.kf!, mid] };
    for (const t of [0, 1, 2, 3, 4]) {
      expect(maskFrameAt(after, t).x).toBeCloseTo(maskFrameAt(m, t).x);
    }
  });
});

describe("mask animation flags", () => {
  test("keys make the mask animated, and the element with it", () => {
    const still = mask();
    const keyed = mask({ kf: [key(0)] });
    expect(hasMaskKeys(still)).toBe(false);
    expect(isMaskAnimated(keyed)).toBe(true);
    const el = { start: 0, end: 4, x: 0.5, y: 0.5 };
    expect(isOverlayAnimated({ ...el, mask: still })).toBe(false);
    expect(isOverlayAnimated({ ...el, mask: keyed })).toBe(true);
  });

  test("behind-subject is an inverted subject mask", () => {
    expect(behindSubjectMask(mask({ kind: "subject", invert: true }))).toBe(true);
    expect(behindSubjectMask(mask({ kind: "subject" }))).toBe(false);
    expect(behindSubjectMask(mask({ invert: true }))).toBe(false);
    expect(behindSubjectMask(undefined)).toBe(false);
  });
});

describe("mask shapes", () => {
  test("every kind is either the person matte or has an outline of its own", async () => {
    const { MASK_KINDS, MASK_SHAPE_KINDS, maskOutlinePathD, maskSizeAxes, maskPolyKind } =
      await import("./mask");
    expect(MASK_SHAPE_KINDS).toEqual(MASK_KINDS.filter((k) => k !== "subject"));
    for (const kind of MASK_SHAPE_KINDS) {
      const d = maskOutlinePathD({ kind }, 200, 100, 1000);
      expect(d.startsWith("M")).toBe(true);
      if (kind !== "linear" && kind !== "mirror") expect(d.endsWith("Z")).toBe(true);
    }
    expect(maskOutlinePathD({ kind: "subject" }, 200, 100, 1000)).toBe("");
    expect(maskSizeAxes("square")).toEqual(["w"]);
    expect(maskSizeAxes("mirror")).toEqual(["h"]);
    expect(maskSizeAxes("linear")).toEqual([]);
    for (const kind of ["heart", "star", "triangle", "diamond", "hexagon"] as const) {
      expect(maskSizeAxes(kind)).toEqual(["w", "h"]);
      expect(maskPolyKind(kind)).toBe(kind);
    }
    expect(maskPolyKind("rect")).toBeNull();
  });

  test("a box outline rounds to its radius and never past its half side", async () => {
    const { maskOutlinePathD } = await import("./mask");
    expect(maskOutlinePathD({ kind: "rect" }, 200, 100, 1000, 0)).toBe("M-100 -50 h200 v100 h-200 Z");
    const rounded = maskOutlinePathD({ kind: "rect" }, 200, 100, 1000, 500);
    expect(rounded).toContain("a50 50");
    // A square's vertical side is its width, so the outline is square.
    expect(maskOutlinePathD({ kind: "square" }, 200, 100, 1000)).toBe("M-100 -100 h200 v200 h-200 Z");
  });
});
