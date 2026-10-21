import { expect, test } from "bun:test";
import { changePct, gridMeans, pickCuts, scoreFrames } from "./cuts";

/** A w×h RGBA frame of one colour. */
const solid = (w: number, h: number, rgb: [number, number, number]) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4);
  return { data, width: w, height: h };
};

test("two frames of the same shot change nothing, a new shot changes every cell", () => {
  const red = gridMeans(solid(64, 64, [200, 20, 20]));
  const alsoRed = gridMeans(solid(64, 64, [204, 18, 22]));
  const blue = gridMeans(solid(64, 64, [20, 20, 200]));
  expect(changePct(red, alsoRed)).toBe(0);
  expect(changePct(red, blue)).toBe(100);
});

test("a cut is a spike against the frames around it", () => {
  // Steady footage, one hard cut at frame 5.
  const scores = [NaN, 1, 0, 2, 1, 95, 1, 0, 2, 1];
  expect(pickCuts(scores)).toEqual([5]);
});

test("a shot one frame long keeps both of its cuts", () => {
  // A flash frame at 4: the cut in and the cut out sit side by side, and
  // neither may hide the other.
  const scores = [NaN, 0, 1, 0, 90, 88, 1, 0, 0];
  expect(pickCuts(scores)).toEqual([4, 5]);
});

test("a pan changes every frame by the same amount and is not a cut", () => {
  const scores = [NaN, 30, 32, 31, 29, 33, 30, 31];
  expect(pickCuts(scores)).toEqual([]);
});

test("a small flicker under the floor is not a cut", () => {
  const scores = [NaN, 0, 0, 5, 0, 0];
  expect(pickCuts(scores)).toEqual([]);
});

/** A w×h RGBA frame of one colour with a rect of another inside it, the rect
 * in pixels [x0, x1) × [y0, y1). */
const card = (w: number, h: number, bg: [number, number, number], ink: [number, number, number], r: [number, number, number, number]) => {
  const px = solid(w, h, bg);
  for (let y = r[2]; y < r[3]; y++) for (let x = r[0]; x < r[1]; x++) px.data.set([...ink, 255], (y * w + x) * 4);
  return px;
};

test("a flat colour swapping for a near one over still frames is a cut", () => {
  // A dark green card cut to a slightly lighter one: every cell moves, each
  // by less than a hard change, and the frames around it are still.
  const frames = [
    ...Array(4).fill([26, 47, 42]),
    ...Array(4).fill([38, 54, 48]),
  ].map((rgb) => solid(64, 64, rgb as [number, number, number]));
  expect(scoreFrames(frames).cuts).toEqual([4]);
});

test("a crossfade moves every cell a little every frame and is not a cut", () => {
  const frames = Array.from({ length: 10 }, (_, i) => solid(64, 64, [239 - i * 10, 170 + i * 8, 127 + i * 9]));
  expect(scoreFrames(frames).cuts).toEqual([]);
});

test("a word appearing on a still card is a change inside the shot, with its box", () => {
  const blank = solid(128, 128, [158, 3, 2]);
  const word = card(128, 128, [158, 3, 2], [227, 177, 177], [72, 96, 56, 70]);
  const { cuts, changes } = scoreFrames([blank, blank, blank, word, word, word]);
  expect(cuts).toEqual([]);
  expect(changes).toHaveLength(1);
  expect(changes[0].frame).toBe(3);
  expect(changes[0].frames).toBe(1);
  expect(changes[0].box.x).toBeCloseTo(84 / 128, 1);
  expect(changes[0].box.y).toBeCloseTo(63 / 128, 1);
  expect(changes[0].box.w).toBeGreaterThan(0.15);
  expect(changes[0].box.w).toBeLessThan(0.3);
});

test("a word fading in over a few frames is one change that runs those frames", () => {
  const bg: [number, number, number] = [158, 3, 2];
  const at = (a: number) => card(128, 128, bg, [Math.round(158 + a * 69), Math.round(3 + a * 174), Math.round(2 + a * 175)], [40, 88, 56, 72]);
  const frames = [at(0), at(0), at(0), at(0.33), at(0.66), at(1), at(1), at(1), at(1)];
  const { cuts, changes } = scoreFrames(frames);
  expect(cuts).toEqual([]);
  expect(changes).toHaveLength(1);
  expect(changes[0].frame).toBe(3);
  expect(changes[0].frames).toBe(3);
});

test("a hard cut is not also reported as a change", () => {
  const red = solid(128, 128, [158, 3, 2]);
  const grey = solid(128, 128, [73, 66, 68]);
  const { cuts, changes } = scoreFrames([red, red, red, grey, grey, grey]);
  expect(cuts).toEqual([3]);
  expect(changes).toEqual([]);
});
