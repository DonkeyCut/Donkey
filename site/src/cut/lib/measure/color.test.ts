import { expect, test } from "bun:test";
import { hexOf, parseHex, regionColor } from "./color";

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
