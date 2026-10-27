import { expect, test } from "bun:test";
import { hexOf, parseHex, regionColor, regionStripes } from "./color";

/** A w×h RGBA frame painted by `paint(x, y)`. */
const frame = (w: number, h: number, paint: (x: number, y: number) => [number, number, number]) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([...paint(x, y), 255], (y * w + x) * 4);
  return { data, width: w, height: h };
};

test("hex round-trips", () => {
  expect(hexOf(255, 90, 0)).toBe("#FF5A00");
  expect(parseHex("#ff5a00")).toEqual([255, 90, 0]);
  expect(parseHex("FF5A00")).toEqual([255, 90, 0]);
  expect(parseHex("#F50")).toEqual([255, 85, 0]);
  expect(parseHex("orange")).toBeNull();
});

test("a flat region reads as its colour with no spread", () => {
  const px = frame(40, 40, () => [255, 90, 0]);
  const out = regionColor(px, { x: 5, y: 5, w: 10, h: 10 });
  expect(out.hex).toBe("#FF5A00");
  expect(out.spread).toBe(0);
  expect(out.dominant).toBeUndefined();
});

test("a split region names both colours by their share", () => {
  // Left 3/4 orange, right 1/4 white.
  const px = frame(40, 40, (x) => (x < 30 ? [255, 90, 0] : [255, 255, 255]));
  const out = regionColor(px, { x: 0, y: 0, w: 40, h: 40 }, 2);
  expect(out.hex).toBe("#FF5A00");
  expect(out.spread).toBeGreaterThan(0);
  expect(out.dominant).toEqual([
    { hex: "#FF5A00", share: 0.75 },
    { hex: "#FFFFFF", share: 0.25 },
  ]);
});

test("a region running off the frame is clipped to it", () => {
  const px = frame(10, 10, () => [0, 0, 0]);
  const out = regionColor(px, { x: 8, y: 8, w: 10, h: 10 });
  expect(out.hex).toBe("#000000");
});

/** Lines `width` px thick every `period` px, their normal `deg` clockwise from
 * the x axis, so the lines themselves run `deg` clockwise from vertical. */
const striped = (deg: number, period: number, width: number, line: [number, number, number], ground: [number, number, number]) => {
  const c = Math.cos((deg * Math.PI) / 180);
  const s = Math.sin((deg * Math.PI) / 180);
  return frame(200, 200, (x, y) => ((((x * c + y * s) % period) + period) % period < width ? line : ground));
};

test("a striped region reads its lines: angle, thickness, gap and both colours", () => {
  const px = striped(-45, 10, 4, [70, 190, 215], [50, 175, 200]);
  const out = regionStripes(px, { x: 20, y: 20, w: 160, h: 160 }, 2);
  expect(out).not.toBeNull();
  expect(out!.angle).toBe(-45);
  // Thickness and gap in px at 1080: two design px per pixel here.
  expect(out!.width).toBeCloseTo(8, 0);
  expect(out!.gap).toBeCloseTo(12, 0);
  expect(out!.line).toBe(hexOf(70, 190, 215));
  expect(out!.ground).toBe(hexOf(50, 175, 200));
});

test("upright and tilted stripes read their direction the way a shape's pattern takes it", () => {
  expect(regionStripes(striped(0, 12, 4, [255, 255, 255], [0, 0, 0]), { x: 0, y: 0, w: 200, h: 200 }, 1)!.angle).toBe(0);
  expect(regionStripes(striped(30, 12, 4, [255, 255, 255], [0, 0, 0]), { x: 0, y: 0, w: 200, h: 200 }, 1)!.angle).toBe(30);
  expect(regionStripes(striped(90, 12, 4, [255, 255, 255], [0, 0, 0]), { x: 0, y: 0, w: 200, h: 200 }, 1)!.angle).toBe(90);
});

test("a flat fill, a split card and a little noise read no stripes", () => {
  expect(regionStripes(frame(80, 80, () => [56, 180, 202]), { x: 0, y: 0, w: 80, h: 80 }, 1)).toBeNull();
  const split = frame(80, 80, (x) => (x < 50 ? [56, 180, 202] : [20, 70, 80]));
  expect(regionStripes(split, { x: 0, y: 0, w: 80, h: 80 }, 1)).toBeNull();
  let seed = 7;
  const grain = frame(80, 80, () => {
    seed = (seed * 16807) % 2147483647;
    const d = (seed % 9) - 4;
    return [56 + d, 180 + d, 202 + d];
  });
  expect(regionStripes(grain, { x: 0, y: 0, w: 80, h: 80 }, 1)).toBeNull();
});
