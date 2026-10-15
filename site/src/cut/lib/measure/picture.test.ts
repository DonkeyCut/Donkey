import { expect, test } from "bun:test";
import type { Pixels } from "./color";
import { areaOf, findPictureBox, intoArea } from "./picture";

// A source's picture is the part of its frame that changes over time. These
// frames are painted from a seed so each sample shows a different shot inside
// the picture, while whatever is around it — bars, an app's buttons — holds
// still, the way a screen recording of an editing app does.

/** A deterministic 0..255 noise from three integers. */
const noise = (a: number, b: number, c: number) => {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) & 255;
};

type Painter = (x: number, y: number, f: number) => number;

function frames(w: number, h: number, n: number, paint: Painter): Pixels[] {
  return Array.from({ length: n }, (_, f) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = paint(x, y, f);
        data.set([v, v, v, 255], (y * w + x) * 4);
      }
    }
    return { data, width: w, height: h };
  });
}

/** Each shot is a smooth field of its own, so neighbouring pixels agree the
 * way footage does. */
const shot = (x: number, y: number, f: number) => noise(Math.floor(x / 6), Math.floor(y / 6), f + 1);

test("a phone recording of an editing app reads as the picture in its middle", () => {
  // 90×160 (9:16). The picture is rows 26–83 (a 16:9 strip across the full
  // width); a timeline strip scrolls at rows 120–131; a clock ticks in a
  // corner; everything else is static chrome with buttons on it.
  const W = 90;
  const H = 160;
  const px = frames(W, H, 24, (x, y, f) => {
    if (y >= 26 && y < 84) return shot(x, y, f);
    if (y >= 120 && y < 132) return noise(Math.floor((x + f * 7) / 5), 3, 0);
    if (y < 6 && x > 70) return noise(x, y, f);
    return noise(Math.floor(x / 15), Math.floor(y / 15), 99) > 128 ? 230 : 40;
  });
  const found = findPictureBox(px)!;
  expect(found.full).toBe(false);
  expect(found.box.x).toBeCloseTo(0.5, 2);
  expect(found.box.w).toBeCloseTo(1, 2);
  expect(found.box.y * H).toBeCloseTo(55, 0);
  expect(found.box.h * H).toBeCloseTo(58, 0);
});

test("a pillarboxed picture reads as the box between the bars", () => {
  const W = 160;
  const H = 90;
  const px = frames(W, H, 16, (x, y, f) => (x >= 40 && x < 120 ? shot(x, y, f) : 0));
  const { box, full } = findPictureBox(px)!;
  expect(full).toBe(false);
  expect(box.x).toBeCloseTo(0.5, 2);
  expect(box.w * W).toBeCloseTo(80, 0);
  expect(box.h).toBeCloseTo(1, 2);
});

test("a picture that fills the frame reads as the whole frame", () => {
  const px = frames(64, 36, 12, shot);
  const { box, full } = findPictureBox(px)!;
  expect(full).toBe(true);
  expect(box).toEqual({ x: 0.5, y: 0.5, w: 1, h: 1 });
});

test("a picture with a static logo inside it keeps its whole box", () => {
  const W = 90;
  const H = 160;
  const px = frames(W, H, 16, (x, y, f) => {
    if (y < 40 || y >= 100) return 20;
    if (x >= 60 && x < 80 && y >= 45 && y < 55) return 255;
    return shot(x, y, f);
  });
  const { box } = findPictureBox(px)!;
  expect(box.y * H).toBeCloseTo(70, 0);
  expect(box.h * H).toBeCloseTo(60, 0);
  expect(box.w).toBeCloseTo(1, 2);
});

test("a source that never changes has no picture to find", () => {
  expect(findPictureBox(frames(32, 32, 8, (x, y) => noise(x, y, 0)))).toBeNull();
  expect(findPictureBox(frames(32, 32, 1, shot))).toBeNull();
});

test("a box inside the picture maps onto the whole frame and back", () => {
  const picture = { x: 0.5, y: 0.3, w: 1, h: 0.32 };
  const inside = { x: 0.25, y: 0.5, w: 0.1, h: 0.2 };
  const onFrame = intoArea(picture, inside);
  expect(onFrame.x).toBeCloseTo(0.25, 6);
  expect(onFrame.y).toBeCloseTo(0.3, 6);
  expect(onFrame.h).toBeCloseTo(0.064, 6);
  const back = areaOf(picture, onFrame);
  expect(back.x).toBeCloseTo(inside.x, 6);
  expect(back.y).toBeCloseTo(inside.y, 6);
  expect(back.w).toBeCloseTo(inside.w, 6);
  expect(back.h).toBeCloseTo(inside.h, 6);
});
