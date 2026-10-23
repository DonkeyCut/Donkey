import { expect, test } from "bun:test";
import { easeAt, type EaseId } from "@donkeycut/effects-kit";
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

test("a faint word fading in over many frames is one change that runs its fade", () => {
  // White on maroon over 12 frames: no single frame moves a cell past the
  // hard tolerance, the fade as a whole does.
  const bg: [number, number, number] = [113, 8, 41];
  const at = (a: number) => card(128, 128, bg, [Math.round(113 + a * 142), Math.round(8 + a * 247), Math.round(41 + a * 214)], [40, 88, 60, 68]);
  const frames = [0, 0, 0, ...Array.from({ length: 12 }, (_, i) => (i + 1) / 12), ...Array(20).fill(1)].map(at);
  const { cuts, changes } = scoreFrames(frames);
  expect(cuts).toEqual([]);
  expect(changes).toHaveLength(1);
  expect(changes[0].frame).toBe(3);
  expect(changes[0].frames).toBe(12);
  expect(changes[0].box.x).toBeCloseTo(64 / 128, 1);
  expect(changes[0].box.y).toBeCloseTo(64 / 128, 1);
});

test("a faint word fading out before a cut is timed inside its shot", () => {
  const bg: [number, number, number] = [113, 8, 41];
  const at = (a: number) => card(128, 128, bg, [Math.round(113 + a * 142), Math.round(8 + a * 247), Math.round(41 + a * 214)], [40, 88, 60, 68]);
  const fadeOut = [...Array(20).fill(1), ...Array.from({ length: 10 }, (_, i) => 1 - (i + 1) / 10), 0, 0, 0].map(at);
  const next = Array.from({ length: 10 }, () => solid(128, 128, [6, 196, 85]));
  const { cuts, changes } = scoreFrames([...fadeOut, ...next]);
  expect(cuts).toEqual([33]);
  expect(changes).toHaveLength(1);
  expect(changes[0].frame).toBe(20);
  expect(changes[0].frames).toBe(10);
});

test("a slow pan over a gradient reports no changes", () => {
  const pan = (shift: number) => {
    const px = solid(128, 128, [0, 0, 0]);
    for (let y = 0; y < 128; y++)
      for (let x = 0; x < 128; x++) {
        const v = Math.round(127 + 120 * Math.sin((x + shift) / 9));
        px.data.set([v, v, 255 - v, 255], (y * 128 + x) * 4);
      }
    return px;
  };
  const { cuts, changes } = scoreFrames(Array.from({ length: 40 }, (_, i) => pan(i * 0.6)));
  expect(cuts).toEqual([]);
  expect(changes).toEqual([]);
});

test("a flash frame inside fast streaking footage keeps both of its cuts", () => {
  // Dark footage whose streaks change most of the picture every frame, then
  // one white flash frame and a bright shot: the flash's change rides no
  // higher than its busy neighbours, but the whole picture leaps to white.
  const streak = (k: number) => card(64, 64, [20, 30, 45], [60, 200, 210], [(k * 13) % 48, ((k * 13) % 48) + 16, 0, 64]);
  const frames = [
    ...Array.from({ length: 6 }, (_, k) => streak(k)),
    solid(64, 64, [240, 240, 230]),
    ...Array(4).fill(solid(64, 64, [90, 160, 200])),
  ];
  const { cuts } = scoreFrames(frames);
  expect([6, 7].filter((i) => cuts.includes(i))).toEqual([6, 7]);
});

test("a cutout flipping to its negative frame by frame is one flicker over its run", () => {
  // A white figure over a blue shot, flipped to black on alternate frames,
  // once held for two frames, the way a strobed cutout plays.
  const bg: [number, number, number] = [40, 120, 200];
  const plain = card(128, 128, bg, [240, 240, 240], [40, 72, 30, 100]);
  const negative = card(128, 128, bg, [15, 15, 15], [40, 72, 30, 100]);
  const shot = solid(128, 128, bg);
  const run = [plain, negative, plain, negative, plain, plain, negative, plain, negative];
  const { changes } = scoreFrames([shot, shot, shot, shot, ...run, shot, shot, shot]);
  const flicker = changes.filter((c) => c.flicker);
  expect(flicker).toHaveLength(1);
  expect(flicker[0].frame).toBe(5);
  expect(flicker[0].frames).toBe(8);
  expect(flicker[0].box.x).toBeCloseTo(56 / 128, 1);
  expect(changes.some((c) => !c.flicker && c.frame > 5 && c.frame < 13)).toBe(false);
});

test("a shape that pops in and out every few frames is no flicker", () => {
  const bg: [number, number, number] = [40, 120, 200];
  const on = card(128, 128, bg, [240, 240, 240], [40, 72, 30, 100]);
  const off = solid(128, 128, bg);
  const frames = Array.from({ length: 30 }, (_, i) => (Math.floor(i / 3) % 2 ? on : off));
  expect(scoreFrames(frames).changes.some((c) => c.flicker)).toBe(false);
});

type Rgb3 = [number, number, number];

/** A card with a word on it, pulled toward `tone` by `f` (0 clear, 1 the
 * tone alone), as the flash effect fades a picture. */
const toned = (f: number, tone: number, bg: Rgb3 = [167, 15, 3], ink: Rgb3 = [240, 220, 200]) => {
  const px = card(96, 54, bg, ink, [30, 66, 20, 34]);
  for (let i = 0; i < px.data.length; i += 4)
    for (let c = 0; c < 3; c++) px.data[i + c] = Math.round(px.data[i + c] + (tone - px.data[i + c]) * f);
  return px;
};

/** Still frames, then a fade along `ease` from frame `start` over `frames`
 * frames to `amount`, then held: into the tone ("to") or out of it ("from"). */
const fadeRun = (o: { ease: EaseId; start: number; frames: number; amount: number; tone: number; way: "to" | "from"; total: number }) =>
  Array.from({ length: o.total }, (_, i) => {
    const e = easeAt(o.ease, (i - o.start) / o.frames);
    return toned(o.amount * (o.way === "to" ? e : 1 - e), o.tone);
  });

test("a picture fading to black is a fade with its curve, not a cut", () => {
  const frames = fadeRun({ ease: "power2.out", start: 10, frames: 14, amount: 1, tone: 0, way: "to", total: 28 });
  const { cuts, changes, fades } = scoreFrames(frames);
  expect(cuts).toEqual([]);
  expect(changes).toEqual([]);
  expect(fades).toHaveLength(1);
  const f = fades[0];
  expect(f.fade).toBe("to");
  expect(f.tone).toBe("black");
  expect(f.ease).toBe("power2.out");
  expect(f.frame).toBeCloseTo(10, 0);
  expect(f.frames).toBeCloseTo(14, 0);
  expect(f.amount).toBeGreaterThan(0.95);
});

test("a fade that stops short of the tone says how far it goes", () => {
  const frames = fadeRun({ ease: "linear", start: 6, frames: 12, amount: 0.6, tone: 0, way: "to", total: 24 });
  const [f] = scoreFrames(frames).fades;
  expect(f.ease).toBe("linear");
  expect(f.amount).toBeCloseTo(0.6, 1);
  expect(f.frames).toBeCloseTo(12, 0);
});

test("a picture clearing out of white is a fade from white", () => {
  const frames = fadeRun({ ease: "sine.in", start: 4, frames: 15, amount: 1, tone: 255, way: "from", total: 26 });
  const { cuts, fades } = scoreFrames(frames);
  expect(cuts).toEqual([]);
  expect(fades).toHaveLength(1);
  expect(fades[0].fade).toBe("from");
  expect(fades[0].tone).toBe("white");
  expect(fades[0].ease).toBe("sine.in");
  expect(fades[0].frame).toBeCloseTo(4, 0);
});

test("a fade cut short by the end of the source is still read whole", () => {
  // The source ends two frames before the fade lands.
  const frames = fadeRun({ ease: "power3.in", start: 8, frames: 16, amount: 1, tone: 0, way: "to", total: 22 });
  const [f] = scoreFrames(frames).fades;
  expect(f.ease).toBe("power3.in");
  expect(f.frames).toBeCloseTo(16, 0);
});

test("a crossfade between two colours and a hard cut are no fades", () => {
  const cross = Array.from({ length: 10 }, (_, i) => solid(64, 64, [239 - i * 10, 170 + i * 8, 127 + i * 9]));
  expect(scoreFrames(cross).fades).toEqual([]);
  const red = solid(128, 128, [158, 3, 2]);
  const black = solid(128, 128, [0, 0, 0]);
  const hard = scoreFrames([red, red, red, red, black, black, black, black]);
  expect(hard.cuts).toEqual([4]);
  expect(hard.fades).toEqual([]);
});
