import { describe, expect, test } from "bun:test";
import {
  evalOverlayAnim,
  hasOverlayAnim,
  loopPeriod,
  shapeMetrics,
  type OverlayAnim,
} from "@donkeycut/effects-kit";
import {
  stampOverlayKinds,
  stripDefaultOverlayKinds,
  type Overlay,
  type ShapeOverlay,
  type TextOverlay,
} from "./types";

/** A title exactly as pre-union documents stored it: no `kind`. */
const legacyTitle = (): TextOverlay => ({
  id: "t1",
  text: "Hello",
  start: 1,
  end: 4,
  x: 0.5,
  y: 0.42,
  size: 88,
  font: "sf",
  weight: 700,
  color: "#FFFFFF",
  shadow: true,
  plate: false,
  lane: 0,
});

describe("overlay kind stamping", () => {
  test("loader stamps text, serializer strips it back — byte-stable round trip", () => {
    const doc = [legacyTitle(), { ...legacyTitle(), id: "t2", plateRadius: 0.4 }];
    const before = JSON.stringify(doc);
    const stamped = stampOverlayKinds(doc);
    for (const o of stamped) expect(o.kind).toBe("text");
    expect(JSON.stringify(stripDefaultOverlayKinds(stamped))).toBe(before);
  });

  test("shapes and stickers keep their kind through serialize", () => {
    const shape: ShapeOverlay = {
      id: "s1",
      kind: "shape",
      shape: "rect",
      start: 0,
      end: 3,
      x: 0.5,
      y: 0.5,
      w: 0.3,
      h: 0.2,
      fill: "#FFFFFF",
    };
    const sticker: Overlay = {
      id: "k1",
      kind: "sticker",
      assetId: "a1",
      start: 0,
      end: 3,
      x: 0.5,
      y: 0.5,
      w: 0.25,
    };
    const out = stripDefaultOverlayKinds([shape, sticker]);
    expect(out[0].kind).toBe("shape");
    expect(out[1].kind).toBe("sticker");
  });

  test("stamping already-stamped elements changes nothing", () => {
    const stamped = stampOverlayKinds([legacyTitle()]);
    expect(stampOverlayKinds(stamped)).toEqual(stamped);
  });
});

describe("shapeMetrics", () => {
  const frame = { width: 1080, height: 1920, scale: 1 }; // 9:16 at design size

  test("rect centers and sizes in frame pixels", () => {
    const o: ShapeOverlay = {
      id: "s",
      kind: "shape",
      shape: "rect",
      start: 0,
      end: 1,
      x: 0.5,
      y: 0.25,
      w: 0.4,
      h: 0.1,
      fill: "#fff",
      radius: 24,
      stroke: { color: "#000", width: 6 },
    };
    const m = shapeMetrics(o, frame);
    expect(m.cx).toBe(540);
    expect(m.cy).toBe(480);
    expect(m.w).toBeCloseTo(432);
    expect(m.h).toBeCloseTo(192);
    expect(m.radius).toBe(24);
    expect(m.strokeWidth).toBe(6);
  });

  test("line thickness rides h with a 2px scaled floor", () => {
    const thin: ShapeOverlay = {
      id: "l",
      kind: "shape",
      shape: "line",
      start: 0,
      end: 1,
      x: 0.5,
      y: 0.5,
      w: 0.4,
      h: 0.0001,
      fill: "#fff",
    };
    expect(shapeMetrics(thin, frame).thickness).toBe(2);
    expect(shapeMetrics({ ...thin, h: 6 / 1920 }, frame).thickness).toBeCloseTo(6);
    // Half-resolution render halves the floor with the scale.
    expect(shapeMetrics(thin, { width: 540, height: 960, scale: 0.5 }).thickness).toBe(1);
  });

  test("arrow head scales with thickness but never eats more than half the length", () => {
    const arrow: ShapeOverlay = {
      id: "a",
      kind: "shape",
      shape: "arrow",
      start: 0,
      end: 1,
      x: 0.5,
      y: 0.5,
      w: 0.1,
      h: 20 / 1920,
      fill: "#fff",
    };
    const m = shapeMetrics(arrow, frame);
    expect(m.headLen).toBeCloseTo(Math.min(m.thickness * 3, m.w / 2));
    const stubby = shapeMetrics({ ...arrow, w: 0.02 }, frame);
    expect(stubby.headLen).toBeLessThanOrEqual(stubby.w / 2 + 1e-9);
  });

  test("metrics scale linearly with render resolution", () => {
    const o: ShapeOverlay = {
      id: "s",
      kind: "shape",
      shape: "ellipse",
      start: 0,
      end: 1,
      x: 0.3,
      y: 0.6,
      w: 0.5,
      h: 0.2,
      fill: "#fff",
      stroke: { color: "#000", width: 8 },
    };
    const at1x = shapeMetrics(o, frame);
    const at2x = shapeMetrics(o, { width: 2160, height: 3840, scale: 2 });
    expect(at2x.cx).toBeCloseTo(at1x.cx * 2);
    expect(at2x.w).toBeCloseTo(at1x.w * 2);
    expect(at2x.strokeWidth).toBeCloseTo(at1x.strokeWidth * 2);
  });
});

describe("evalOverlayAnim", () => {
  const dur = 5;

  test("no anim (or empty anim) is the identity", () => {
    expect(evalOverlayAnim(undefined, 1, dur)).toEqual({ dx: 0, dy: 0, scale: 1, rotate: 0, alpha: 1 });
    expect(hasOverlayAnim({})).toBe(false);
    expect(hasOverlayAnim({ in: { style: "fade", seconds: 0.5 } })).toBe(true);
  });

  test("fade in ramps alpha 0→1 monotonically and idles after", () => {
    const anim: OverlayAnim = { in: { style: "fade", seconds: 1 } };
    expect(evalOverlayAnim(anim, 0, dur).alpha).toBe(0);
    let prev = -1;
    for (let t = 0; t <= 1; t += 0.1) {
      const a = evalOverlayAnim(anim, t, dur).alpha;
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
    expect(evalOverlayAnim(anim, 2, dur).alpha).toBe(1);
    expect(evalOverlayAnim(anim, 2, dur).dx).toBe(0);
  });

  test("slideleft enters from the right and lands exactly at rest", () => {
    const anim: OverlayAnim = { in: { style: "slideleft", seconds: 0.5 } };
    expect(evalOverlayAnim(anim, 0, dur).dx).toBeGreaterThan(0);
    expect(evalOverlayAnim(anim, 0.5, dur).dx).toBeCloseTo(0, 5);
    // Exit runs the motion onward: slideleft leaves toward the left.
    const out: OverlayAnim = { out: { style: "slideleft", seconds: 0.5 } };
    expect(evalOverlayAnim(out, dur - 0.01, dur).dx).toBeLessThan(0);
    expect(evalOverlayAnim(out, dur - 0.5, dur).dx).toBeCloseTo(0, 5);
  });

  test("fade out ramps alpha to 0 at the very end", () => {
    const anim: OverlayAnim = { out: { style: "fade", seconds: 1 } };
    expect(evalOverlayAnim(anim, dur - 1.01, dur).alpha).toBe(1);
    expect(evalOverlayAnim(anim, dur, dur).alpha).toBe(0);
  });

  test("typewriter reports character progress instead of moving", () => {
    const anim: OverlayAnim = { in: { style: "typewriter", seconds: 1 } };
    const mid = evalOverlayAnim(anim, 0.5, dur);
    expect(mid.textProgress).toBeCloseTo(0.5, 5);
    expect(mid.alpha).toBe(1);
    expect(evalOverlayAnim(anim, 2, dur).textProgress).toBeUndefined();
  });

  test("loops are periodic and loopPeriod matches", () => {
    const anim: OverlayAnim = { loop: { style: "pulse", speed: 2 } };
    const p = loopPeriod(anim)!;
    expect(p).toBeCloseTo(0.6, 5);
    const a = evalOverlayAnim(anim, 1.1, dur);
    const b = evalOverlayAnim(anim, 1.1 + p, dur);
    expect(a.scale).toBeCloseTo(b.scale, 5);
    expect(loopPeriod({ in: { style: "fade", seconds: 1 } }) === null).toBe(true);
  });

  test("loop composes with the in ramp", () => {
    const anim: OverlayAnim = { in: { style: "fade", seconds: 1 }, loop: { style: "float", speed: 1 } };
    const s = evalOverlayAnim(anim, 0.5, dur);
    expect(s.alpha).toBeGreaterThan(0);
    expect(s.alpha).toBeLessThan(1);
  });
});
