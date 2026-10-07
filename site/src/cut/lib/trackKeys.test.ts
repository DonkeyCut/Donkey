import { describe, expect, test } from "bun:test";
import { followKeys, keepTurns, pictureToFrame, settleTrack, trackedMask, type TrackSample } from "./trackKeys";
import type { Overlay, VideoClip } from "./types";

const tune = { smoothCutoff: 1.5, smoothBeta: 20, bridgeSeconds: 0.25, keyTolerance: 0.0015 };

const clip = (over: Partial<VideoClip> = {}): VideoClip =>
  ({ id: "c1", assetId: "a1", start: 0, in: 0, out: 10, track: 0, ...over }) as VideoClip;

/** A square target of half-side `r` centered at (x, y), axis left to right. */
const at = (x: number, y: number, r = 0.1): TrackSample => ({
  outline: [
    { x: x - r, y: y - r },
    { x: x + r, y: y - r },
    { x: x + r, y: y + r },
    { x: x - r, y: y + r },
  ],
  center: { x, y },
  axis: [{ x: x - r, y }, { x: x + r, y }],
});

const times = (n: number, fps = 30) => Array.from({ length: n }, (_, i) => i / fps);

describe("settling a track", () => {
  test("a short dropout is bridged by blending its neighbors", () => {
    const t = times(5);
    const out = settleTrack(t, [at(0.2, 0.5), null, null, at(0.2, 0.5), at(0.2, 0.5)], tune);
    expect(out.every((s) => s !== null)).toBe(true);
  });

  test("a long dropout stays a gap, and the run after it restarts the filter", () => {
    const t = times(20);
    const samples = t.map((_, i) => (i === 0 ? at(0.2, 0.5) : i === 19 ? at(0.8, 0.5) : null));
    const out = settleTrack(t, samples, tune);
    expect(out.slice(1, 19).every((s) => s === null)).toBe(true);
    // A fresh run starts exactly where the target is, with no pull from before.
    expect(out[19]!.center.x).toBeCloseTo(0.8, 6);
  });

  test("jitter on a still target is taken down", () => {
    const t = times(60);
    const noisy = t.map((_, i) => at(0.5 + (i % 2 ? 0.004 : -0.004), 0.5));
    const out = settleTrack(t, noisy, tune);
    const tail = out.slice(30).map((s) => s!.center.x);
    expect(Math.max(...tail) - Math.min(...tail)).toBeLessThan(0.004);
  });

  test("a fast move stays close behind the target", () => {
    const t = times(30);
    const moving = t.map((s) => at(0.1 + s * 0.8, 0.5));
    const out = settleTrack(t, moving, tune);
    expect(Math.abs(out[29]!.center.x - moving[29].center.x)).toBeLessThan(0.01);
  });
});

describe("placing the source picture in the frame", () => {
  test("a matching aspect maps straight through", () => {
    const place = pictureToFrame(clip(), { width: 1080, height: 1920 }, "9:16");
    expect(place({ x: 0.25, y: 0.75 })).toEqual({ x: 0.25, y: 0.75 });
  });

  test("a landscape picture fitted into a vertical frame letterboxes", () => {
    const place = pictureToFrame(clip(), { width: 1920, height: 1080 }, "9:16");
    const top = place({ x: 0, y: 0 });
    expect(top.x).toBeCloseTo(0, 6);
    expect(top.y).toBeCloseTo((1920 - 1080 * (1080 / 1920)) / 2 / 1920, 6);
  });

  test("a covering clip crops and a mirrored one flips about its region", () => {
    const place = pictureToFrame(clip({ fit: "fill", flipH: true }), { width: 1920, height: 1080 }, "9:16");
    // Covering: the picture's center column lands on the frame's center.
    expect(place({ x: 0.5, y: 0.5 }).x).toBeCloseTo(0.5, 6);
    // Mirrored: a point right of center lands left of it.
    expect(place({ x: 0.55, y: 0.5 }).x).toBeLessThan(0.5);
  });
});

describe("a tracked mask", () => {
  test("keys the outline relative to the clip's region and folds it where the target is gone", () => {
    const t = times(4);
    const m = trackedMask({ kind: "clip", clip: clip() }, "9:16", t, [at(0.6, 0.5), at(0.6, 0.5), null, null], {}, 0)!;
    expect(m.kind).toBe("pen");
    expect(m.kf![0].points![0]).toEqual({ x: 0, y: -0.1 });
    const folded = m.kf![m.kf!.length - 1].points!;
    expect(folded.every((p) => p.x === 0.1 && p.y === 0)).toBe(true);
  });

  test("on an element, the outline is carried back through the element's pose", () => {
    const overlay = { id: "o1", kind: "shape", start: 0, end: 1, x: 0.5, y: 0.5, kf: [{ t: 0, x: 0.3, y: 0.5, scale: 2, rotation: 0, opacity: 1 }] } as unknown as Overlay;
    const m = trackedMask({ kind: "overlay", overlay }, "9:16", [0], [at(0.3, 0.5)], {}, 0)!;
    // The element sits at x 0.3, scaled 2×: the target's corner 0.1 to its
    // left is 0.05 in the element's own space.
    expect(m.points![0].x).toBeCloseTo(-0.05, 6);
  });

  test("an element with motion blur or a group camera still takes a tracked mask", () => {
    const overlay = { id: "o1", kind: "shape", start: 0, end: 1, x: 0.3, y: 0.5, motionBlur: 0.5, groupId: "g", camera: { kf: [{ t: 0, x: 0.5, y: 0.5, scale: 2, rotation: 0 }] } } as unknown as Overlay;
    const m = trackedMask({ kind: "overlay", overlay }, "9:16", [0], [at(0.3, 0.5)], {}, 0)!;
    // The camera's 2× zoom about the center moves the element to x 0.1.
    expect(m.points![0].x).toBeCloseTo(0.05, 6);
  });

  test("straight stretches drop their middle keys", () => {
    const t = times(30);
    const m = trackedMask({ kind: "clip", clip: clip() }, "9:16", t, t.map((s) => at(0.2 + s * 0.3, 0.5)), {}, 0.0015)!;
    expect(m.kf!.length).toBe(2);
  });
});

describe("following a target", () => {
  test("the item keeps its offset, grows with the target and turns with it", () => {
    const t = [0, 1];
    const turned: TrackSample = {
      outline: [],
      center: { x: 0.5, y: 0.5 },
      axis: [{ x: 0.5, y: 0.5 - 0.2 * (9 / 16) }, { x: 0.5, y: 0.5 + 0.2 * (9 / 16) }],
    };
    const keys = followKeys(
      { kind: "clip", clip: clip() },
      "9:16",
      t,
      [at(0.5, 0.5), turned],
      { x: 0.6, y: 0.5, scale: 1, rotation: 0, opacity: 1 },
      "move_scale_turn",
      0
    );
    expect(keys[0]).toMatchObject({ x: 0.6, y: 0.5, scale: 1, rotation: 0 });
    expect(keys[1].rotation).toBeCloseTo(90, 1);
    expect(keys[1].scale).toBeCloseTo(2, 2);
    expect(keys[1].x).toBeCloseTo(0.5, 3);
  });

  test("moments without the target write no key", () => {
    const keys = followKeys({ kind: "clip", clip: clip() }, "9:16", times(3), [at(0.5, 0.5), null, at(0.6, 0.5)], { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 }, "move", 0);
    expect(keys.map((k) => k.x)).toEqual([0.5, 0.6]);
  });
});

describe("keeping keys", () => {
  test("keeps the corners of a path and drops points on its lines", () => {
    const t = [0, 1, 2, 3, 4];
    const v = [[0], [1], [2], [1], [0]];
    expect(keepTurns(t, v, 0.01)).toEqual([0, 2, 4]);
  });
});
