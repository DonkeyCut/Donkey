import { expect, test } from "bun:test";
import { inkBox, shapeBox } from "./track";

type Rgb = [number, number, number];

/** A w×h RGBA frame on `bg`, with rectangles painted over it. */
const frame = (w: number, h: number, bg: Rgb, rects: { x: number; y: number; w: number; h: number; c: Rgb }[]) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...bg, 255], i * 4);
  for (const r of rects)
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) data.set([...r.c, 255], (y * w + x) * 4);
  return { data, width: w, height: h };
};

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
const ORANGE: Rgb = [255, 90, 0];
const all = { x: 0, y: 0, w: 100, h: 100 };

test("the shape box is the piece of that colour at the seed, and only it", () => {
  // Two orange cards: the seed sits on the left one.
  const px = frame(100, 100, BLACK, [
    { x: 10, y: 20, w: 20, h: 10, c: ORANGE },
    { x: 60, y: 60, w: 30, h: 30, c: ORANGE },
  ]);
  expect(shapeBox(px, ORANGE, 40, all, { x: 12, y: 22, w: 4, h: 4 })).toEqual({ x: 10, y: 20, w: 20, h: 10 });
});

test("a shape that left the seed is found by its nearest piece", () => {
  const px = frame(100, 100, BLACK, [{ x: 40, y: 20, w: 20, h: 10, c: ORANGE }]);
  expect(shapeBox(px, ORANGE, 40, all, { x: 10, y: 20, w: 20, h: 10 })).toEqual({ x: 40, y: 20, w: 20, h: 10 });
});

test("no piece of that colour is no box", () => {
  const px = frame(100, 100, BLACK, []);
  expect(shapeBox(px, ORANGE, 40, all, { x: 10, y: 20, w: 20, h: 10 })).toBeNull();
});

test("the ink box spans every letter inside the region", () => {
  // Three white "letters" on black, and a white mark outside the region.
  const px = frame(100, 100, BLACK, [
    { x: 20, y: 40, w: 6, h: 12, c: WHITE },
    { x: 30, y: 44, w: 6, h: 8, c: WHITE },
    { x: 40, y: 40, w: 6, h: 14, c: WHITE },
    { x: 90, y: 5, w: 5, h: 5, c: WHITE },
  ]);
  expect(inkBox(px, WHITE, 40, { x: 10, y: 30, w: 50, h: 40 })).toEqual({ x: 20, y: 40, w: 26, h: 14 });
});

test("a stray pixel of the colour does not stretch the ink box", () => {
  const px = frame(100, 100, BLACK, [
    { x: 20, y: 40, w: 20, h: 10, c: WHITE },
    { x: 5, y: 90, w: 1, h: 1, c: WHITE },
  ]);
  expect(inkBox(px, WHITE, 40, all)).toEqual({ x: 20, y: 40, w: 20, h: 10 });
});
