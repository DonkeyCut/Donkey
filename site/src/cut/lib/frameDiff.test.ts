import { expect, test } from "bun:test";
import { bestShift, diffPixels, edgeBand, inkColor, inkDiff, inkOff, meanDiff, runShift, sweepStats, worstStretches } from "./frameDiff";

// The numbers a replica is judged by. A score is only useful to the model if
// it means the same thing every call: 0 for identical frames, 255 for black
// against white, and a grid that puts the difference where it is.

/** A w×h RGBA frame, every pixel `rgb`. */
const solid = (w: number, h: number, rgb: [number, number, number]) => {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set([...rgb, 255], i * 4);
  return px;
};

test("identical frames score 0 everywhere", () => {
  const a = solid(8, 8, [40, 90, 200]);
  const out = diffPixels(a, a.slice(), 8, 8);
  expect(out.diff).toBe(0);
  expect(out.grid).toEqual([
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
});

test("the score is the mean channel difference on a 0-255 scale", () => {
  expect(diffPixels(solid(8, 8, [0, 0, 0]), solid(8, 8, [255, 255, 255]), 8, 8).diff).toBe(255);
  // Alpha is not part of the picture, so it never counts.
  expect(diffPixels(solid(4, 4, [10, 20, 30]), solid(4, 4, [20, 10, 60]), 4, 4).diff).toBeCloseTo(50 / 3, 5);
});

test("a difference in one corner shows in that corner's cell", () => {
  const a = solid(8, 8, [0, 0, 0]);
  const b = a.slice();
  // The top-right 2×2 block of an 8×8 frame is grid cell [0][3].
  for (const [x, y] of [[6, 0], [7, 0], [6, 1], [7, 1]]) b.set([120, 120, 120], (y * 8 + x) * 4);
  const out = diffPixels(a, b, 8, 8);
  expect(out.grid[0][3]).toBe(120);
  expect(out.grid[3][0]).toBe(0);
  expect(out.diff).toBeCloseTo(120 / 16, 5);
});

test("a grid cell still reads on a frame smaller than the grid's split would like", () => {
  const out = diffPixels(solid(6, 10, [0, 0, 0]), solid(6, 10, [9, 9, 9]), 6, 10);
  expect(out.grid.flat().every((v) => v === 9)).toBe(true);
});

test("meanDiff is diffPixels' score without the grid", () => {
  const a = solid(5, 5, [1, 2, 3]);
  const b = solid(5, 5, [4, 8, 12]);
  expect(meanDiff(a, b)).toBeCloseTo(diffPixels(a, b, 5, 5).diff, 5);
});

test("a shift is named only when it matches clearly better than the moment asked for", () => {
  // A static frame matches every neighbour equally: no timing to fix.
  expect(bestShift(12, [{ shift: -0.033, diff: 12 }, { shift: 0.033, diff: 11.8 }])).toBeUndefined();
  // A move that lands two frames late in the cut: the source two frames on is
  // a near match.
  expect(bestShift(14, [{ shift: -0.033, diff: 20 }, { shift: 0.067, diff: 1.5 }])).toEqual({
    shift: 0.067,
    diff: 1.5,
  });
  // A frame that already matches has nothing to gain.
  expect(bestShift(0.6, [{ shift: 0.033, diff: 0.1 }])).toBeUndefined();
});

test("sweep stats are the median, the 95th percentile and the worst", () => {
  const scores = Array.from({ length: 100 }, (_, i) => i + 1);
  expect(sweepStats(scores)).toEqual({ median: 50, p95: 95, max: 100 });
  expect(sweepStats([7])).toEqual({ median: 7, p95: 7, max: 7 });
});

test("worst stretches group neighbouring bad samples and rank by how much is wrong", () => {
  const step = 0.5;
  const diffs = [1, 1, 30, 32, 1, 1, 1, 9, 1, 1, 1, 60];
  const samples = diffs.map((diff, i) => ({ at: i * step, diff }));
  const out = worstStretches(samples, step, 5, 5);
  // One frame far off outweighs two a long way off, and both outweigh one
  // barely past the target.
  expect(out.map((s) => [s.from, s.to])).toEqual([
    [5.5, 6],
    [1, 2],
    [3.5, 4],
  ]);
  expect(out[1].diff).toBe(31);
  expect(out[1].peak).toBe(32);
  expect(out[1].peakAt).toBe(1.5);
  expect(out[1].peakIndex).toBe(3);
  expect([out[1].first, out[1].last]).toEqual([2, 3]);
});

test("a single dip between bad samples does not split a stretch", () => {
  const samples = [1, 20, 2, 20, 1, 1].map((diff, i) => ({ at: i, diff }));
  expect(worstStretches(samples, 1, 5, 5).map((s) => [s.from, s.to])).toEqual([[1, 4]]);
});

test("a cut that matches everywhere has no worst stretch", () => {
  const samples = [1, 2, 3, 4, 2].map((diff, i) => ({ at: i, diff }));
  expect(worstStretches(samples, 1, 5, 5)).toEqual([]);
});

test("a cut off by the same amount everywhere is one stretch, not noise", () => {
  const samples = [30, 30, 30, 30].map((diff, i) => ({ at: i, diff }));
  expect(worstStretches(samples, 1, 5, 5).map((s) => [s.from, s.to])).toEqual([[0, 4]]);
});

test("worst stretches stop at the limit", () => {
  const samples = [9, 1, 1, 9, 1, 1, 9, 1, 1, 9].map((diff, i) => ({ at: i, diff }));
  expect(worstStretches(samples, 1, 5, 2)).toHaveLength(2);
});

test("a run of sweep samples that each match the source a step later reads as one shift", () => {
  // Three samples, each scored against the source one step either side:
  // [k=-1, k=0, k=+1]. The first has no source sample before it.
  const near = new Float32Array([NaN, 30, 2, 40, 28, 1, 35, 32, 3]);
  expect(runShift(near, 1, 0, 2, 0.5)).toEqual({ shift: 0.5, diff: 2 });
  // Over the middle sample alone it still reads late; with no neighbours
  // at all there is nothing to say.
  expect(runShift(near, 1, 1, 1, 0.5)?.shift).toBe(0.5);
  expect(runShift(new Float32Array([NaN, 9, NaN]), 1, 0, 0, 0.5)).toBeUndefined();
});

test("a difference along a whole edge while the middle matches is a band, under target too", () => {
  // Thin black bars over a colour: the top and bottom rows of the grid run
  // warm end to end, the middle is quiet, and the frame's mean stays low.
  const bars = [
    [7, 7, 8, 7],
    [1, 0, 1, 1],
    [1, 1, 0, 1],
    [6, 7, 7, 7],
  ];
  expect(edgeBand(bars, 5)).toEqual({ edges: ["top", "bottom"], diff: 7 });
  const pillars = bars[0].map((_, c) => bars.map((row) => row[c]));
  expect(edgeBand(pillars, 5)?.edges).toEqual(["left", "right"]);
  // A title near the top warms part of that row, not all of it.
  expect(edgeBand([[9, 9, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1]], 5)).toBeNull();
  // A frame off everywhere is off everywhere, not at its edges.
  expect(edgeBand([[9, 9, 9, 9], [9, 9, 9, 9], [9, 9, 9, 9], [9, 9, 9, 9]], 5)).toBeNull();
  // A faint edge is noise.
  expect(edgeBand([[3, 3, 3, 3], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], 5)).toBeNull();
});

/** A w×h frame of `ground` with a `rgb` block of letters-like strokes at x 4..5, 8..9 of rows 3..5. */
const lettered = (w: number, h: number, ground: [number, number, number], rgb: [number, number, number]) => {
  const px = solid(w, h, ground);
  for (const x of [4, 5, 8, 9]) for (let y = 3; y <= 5; y++) px.set([...rgb, 255], (y * w + x) * 4);
  return px;
};

test("a title's ink is the colour its letters stand off the ground in", () => {
  const box = { x: 2, y: 2, w: 10, h: 5 };
  expect(inkColor(lettered(16, 9, [237, 105, 87], [0, 0, 0]), 16, 9, box)).toEqual({ ink: [0, 0, 0], ground: [237, 105, 87] });
  expect(inkColor(lettered(16, 9, [237, 105, 87], [255, 255, 255]), 16, 9, box)?.ink).toEqual([255, 255, 255]);
  // Nothing stands off a flat ground: no letters, only the ground.
  expect(inkColor(solid(16, 9, [237, 105, 87]), 16, 9, box)).toEqual({ ink: null, ground: [237, 105, 87] });
});

test("white letters where the source has black ones are off; the same letters a shade apart aren't", () => {
  const box = { x: 0, y: 0, w: 16, h: 9 };
  const black = inkColor(lettered(16, 9, [237, 105, 87], [0, 0, 0]), 16, 9, box)!;
  const white = inkColor(lettered(16, 9, [237, 105, 87], [255, 255, 255]), 16, 9, box)!;
  const softer = inkColor(lettered(16, 9, [237, 105, 87], [20, 14, 12]), 16, 9, box)!;
  expect(inkOff(white, black)).toBeGreaterThan(150);
  expect(inkOff(softer, black)).toBeLessThan(30);
  expect(inkDiff(white.ink!, black.ink!)).toBe(255);
});

test("thinner letters of the same colour, blended into their ground, are not off", () => {
  // White on purple, and the source's white read through its thin strokes:
  // part way from the ground to white.
  const ours = { ink: [255, 255, 255] as [number, number, number], ground: [184, 3, 239] as [number, number, number] };
  const thin = { ink: [219, 155, 231] as [number, number, number], ground: [184, 3, 239] as [number, number, number] };
  expect(inkOff(ours, thin)).toBeLessThan(30);
});

test("tan letters where the source's are pale cyan are off, though both stand bright off black", () => {
  const tan = { ink: [204, 166, 151] as [number, number, number], ground: [0, 0, 0] as [number, number, number] };
  const cyan = { ink: [187, 231, 245] as [number, number, number], ground: [0, 0, 0] as [number, number, number] };
  expect(inkOff(tan, cyan)).toBeGreaterThan(64);
});

test("letters over another ground are left to the frame score", () => {
  // Ours reads the red card's edge off black; the source's white label sits on the card.
  const edge = { ink: [243, 47, 48] as [number, number, number], ground: [0, 0, 0] as [number, number, number] };
  const label = { ink: [230, 186, 185] as [number, number, number], ground: [242, 46, 48] as [number, number, number] };
  expect(inkOff(edge, label)).toBeNull();
});

test("a box past the frame's edge reads only what is inside it", () => {
  const px = lettered(16, 9, [0, 0, 0], [255, 255, 255]);
  expect(inkColor(px, 16, 9, { x: 6, y: -4, w: 20, h: 20 })?.ink).toEqual([255, 255, 255]);
  expect(inkColor(px, 16, 9, { x: 20, y: 20, w: 4, h: 4 })).toBeNull();
});

test("a small label that fills its own box reads its ground off what's around it", () => {
  const px = solid(16, 9, [44, 75, 241]);
  for (let y = 3; y <= 5; y++) for (let x = 6; x <= 9; x++) px.set([235, 238, 254, 255], (y * 16 + x) * 4);
  expect(inkColor(px, 16, 9, { x: 6, y: 3, w: 4, h: 3 })).toEqual({ ink: [235, 238, 254], ground: [44, 75, 241] });
});

test("letters the source shows where yours don't are off by how far they stand out", () => {
  // A strobe's white frame: the source's letters read pale cyan on white,
  // ours wash out into the white.
  const white = [249, 245, 244] as [number, number, number];
  const gone = { ink: null, ground: white };
  const cyan = { ink: [184, 232, 253] as [number, number, number], ground: white };
  expect(inkOff(gone, cyan)).toBe(65);
  expect(inkOff(cyan, gone)).toBe(65);
  // Neither shows letters: nothing to tell apart.
  expect(inkOff(gone, gone)).toBe(0);
});
