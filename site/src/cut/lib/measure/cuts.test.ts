import { expect, test } from "bun:test";
import { changePct, gridMeans, pickCuts } from "./cuts";

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
