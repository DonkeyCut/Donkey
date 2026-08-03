import { describe, expect, test } from "bun:test";
import {
  evalOverlayFrame,
  hasOverlayKeys,
  isOverlayAnimated,
  keyAt,
  keyIndexAt,
  poseAt,
  poseExtent,
  removeKeyAt,
  upsertKey,
  type OverlayKey,
} from "./keys";

const el = (over: Partial<Parameters<typeof poseAt>[0]> = {}) => ({
  start: 2,
  end: 6,
  x: 0.5,
  y: 0.5,
  ...over,
});
const key = (t: number, over: Partial<OverlayKey> = {}): OverlayKey => ({
  t,
  x: 0.5,
  y: 0.5,
  scale: 1,
  rotation: 0,
  opacity: 1,
  ...over,
});

describe("keyframe poses", () => {
  test("no keys leaves the element at rest", () => {
    const o = el({ rotation: 30, opacity: 0.5 });
    expect(poseAt(o, 1)).toEqual({ x: 0.5, y: 0.5, scale: 1, rotation: 30, opacity: 0.5 });
    expect(hasOverlayKeys(o)).toBe(false);
    expect(isOverlayAnimated(o)).toBe(false);
  });

  test("the pose moves between keys and holds outside them", () => {
    const o = el({ kf: [key(1, { x: 0.2 }), key(3, { x: 0.8, scale: 2 })] });
    expect(poseAt(o, 0).x).toBeCloseTo(0.2); // held before the first
    expect(poseAt(o, 2).x).toBeCloseTo(0.5); // halfway
    expect(poseAt(o, 2).scale).toBeCloseTo(1.5);
    expect(poseAt(o, 9).x).toBeCloseTo(0.8); // held after the last
  });

  test("keys handed over out of order still play in time order", () => {
    const o = el({ kf: [key(3, { x: 0.8 }), key(1, { x: 0.2 })] });
    expect(poseAt(o, 2).x).toBeCloseTo(0.5);
  });

  test("rotation takes the short way around", () => {
    const o = el({ kf: [key(0, { rotation: -170 }), key(2, { rotation: 170 })] });
    // Through -180, not forward through zero.
    expect(poseAt(o, 1).rotation).toBeCloseTo(-180);
  });

  test("a new key captures the pose, so adding one changes nothing", () => {
    const o = el({ kf: [key(0, { x: 0.2 }), key(4, { x: 0.6 })] });
    const mid = keyAt(o, 2);
    const after = { ...o, kf: upsertKey(o.kf, mid) };
    for (const t of [0, 1, 2, 3, 4]) {
      expect(poseAt(after, t).x).toBeCloseTo(poseAt(o, t).x);
    }
  });

  test("a key dropped on an existing one replaces it", () => {
    const kf = upsertKey([key(1, { x: 0.2 })], key(1.001, { x: 0.9 }));
    expect(kf.length).toBe(1);
    expect(kf[0].x).toBeCloseTo(0.9);
    expect(keyIndexAt(kf, 1)).toBe(0);
    expect(removeKeyAt(kf, 1).length).toBe(0);
  });
});

describe("presets composing over a pose", () => {
  test("a fade multiplies the keyed opacity instead of replacing it", () => {
    const o = el({
      kf: [key(0, { opacity: 0.6 })],
      anim: { in: { style: "fade", seconds: 1 } },
    });
    expect(evalOverlayFrame(o, 0.5).opacity).toBeCloseTo(0.3); // 0.6 × half-faded
    expect(evalOverlayFrame(o, 2).opacity).toBeCloseTo(0.6); // ramp done
  });

  test("a slide's travel rides on top of the keyed position", () => {
    const o = el({ kf: [key(0, { x: 0.2 }), key(4, { x: 0.8 })] });
    const withSlide = { ...o, anim: { in: { style: "slideleft" as const, seconds: 1 } } };
    const plain = evalOverlayFrame(o, 0.5);
    const slid = evalOverlayFrame(withSlide, 0.5);
    expect(slid.x).toBeCloseTo(plain.x); // the pose is untouched…
    expect(slid.dx).toBeGreaterThan(0); // …and the travel is separate
  });

  test("a pulse loop multiplies the keyed scale", () => {
    const o = el({
      kf: [key(0, { scale: 2 })],
      anim: { loop: { style: "pulse" as const, speed: 1 } },
    });
    // The loop swings ±6% about the keyed size, never about 1.
    const scales = Array.from({ length: 40 }, (_, i) => evalOverlayFrame(o, i / 20).scale);
    expect(Math.min(...scales)).toBeGreaterThan(2 * 0.9);
    expect(Math.max(...scales)).toBeLessThan(2 * 1.1);
  });

  test("keys alone count as animated", () => {
    expect(isOverlayAnimated(el({ kf: [key(0)] }))).toBe(true);
    expect(isOverlayAnimated(el({ anim: { loop: { style: "spin", speed: 1 } } }))).toBe(true);
  });
});

describe("the region a keyed element sweeps", () => {
  test("spans every pose and the largest scale", () => {
    const o = el({ kf: [key(0, { x: 0.2, y: 0.4 }), key(3, { x: 0.9, y: 0.5, scale: 2.5 })] });
    expect(poseExtent(o)).toEqual({ x0: 0.2, y0: 0.4, x1: 0.9, y1: 0.5, scale: 2.5 });
  });

  test("an unkeyed element sweeps only its own spot", () => {
    expect(poseExtent(el({ x: 0.3, y: 0.7 }))).toEqual({
      x0: 0.3,
      y0: 0.7,
      x1: 0.3,
      y1: 0.7,
      scale: 1,
    });
  });
});
