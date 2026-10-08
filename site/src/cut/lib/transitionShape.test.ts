import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Canvas } from "skia-canvas";
import { FrameCompositor, type Frame } from "./composite";
import { setRasterFactory, type RasterSurface } from "./raster";
import { shapeEase, sliceSpeed } from "./transitionShape";
import { xfadeTransition } from "../server/transitionExpr";
import type { TransitionStyle, VideoClip } from "./types";

/**
 * The shaped transitions draw the same frames on the compositor's canvas
 * (preview and the tab's export) and in the ffmpeg export's xfade
 * expressions: a white outgoing shot handing over to a black incoming one,
 * compared pixel by pixel at the same moments.
 */

const W = 90;
const H = 160;
const FPS = 30;
const SECONDS = 0.5;
const FRAMES = Math.round(SECONDS * FPS);
const FFMPEG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../vendor/donkey-tools/ffmpeg");

beforeAll(() => {
  setRasterFactory({
    createCanvas: (w, h) => new Canvas(w, h) as unknown as RasterSurface,
    decodeImage: async () => null,
    canvasToBlob: async () => new Blob(),
    snapshot: async (canvas) => canvas as unknown as ImageBitmap,
  });
});

/** A solid shot. */
function solid(color: string): Frame {
  const c = new Canvas(W, H);
  const ctx = c.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, W, H);
  return { kind: "ready", image: c as unknown as CanvasImageSource, width: W, height: H };
}

const clipOf = (over: Partial<VideoClip> = {}): VideoClip => ({
  id: "c1",
  assetId: "a1",
  track: 0,
  start: 0,
  in: 0,
  out: 4,
  muted: false,
  transition: SECONDS,
  ...over,
});

/** The compositor's frame at progress `p`, as luma bytes. */
function canvasFrame(style: TransitionStyle, p: number, feather?: number): Uint8Array {
  const canvas = new Canvas(W, H);
  const comp = new FrameCompositor(canvas as unknown as HTMLCanvasElement);
  const master = clipOf({ transitionStyle: style, ...(feather ? { transitionFeather: feather } : {}) });
  comp.drawCrossJoin(
    style,
    p,
    {
      masterFrame: solid("#ffffff"),
      masterClip: master,
      masterAlpha: 1,
      masterZoom: 1,
      masterFx: { dx: 0, dy: 0 },
      incFrame: solid("#000000"),
      incClip: clipOf({ id: "c2" }),
      incAlpha: p,
      incZoom: 1,
    },
    0
  );
  const rgba = canvas.getContext("2d").getImageData(0, 0, W, H).data;
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    out[i] = rgba[i * 4];
  }
  return out;
}

/** Every frame of the ffmpeg join, as luma bytes. Frame n stands at
 * progress n / FRAMES. */
function ffmpegFrames(style: TransitionStyle, feather?: number): Uint8Array[] {
  const opt = xfadeTransition(style, feather, SECONDS, W, H);
  const graph =
    `color=c=white:s=${W}x${H}:r=${FPS}:d=${SECONDS},format=yuv420p[a];` +
    `color=c=black:s=${W}x${H}:r=${FPS}:d=${SECONDS * 2},format=yuv420p[b];` +
    `[a][b]xfade=${opt}:duration=${SECONDS}:offset=0,format=gray[out]`;
  const run = spawnSync(FFMPEG, ["-v", "error", "-filter_complex", graph, "-map", "[out]", "-frames:v", String(FRAMES), "-f", "rawvideo", "-"]);
  expect(run.stderr.toString()).toBe("");
  expect(run.status).toBe(0);
  return [...Array(FRAMES).keys()].map((n) => new Uint8Array(run.stdout.subarray(n * W * H, (n + 1) * W * H)));
}

/** The mean luma difference between two frames, 0..255. */
const meanDiff = (a: Uint8Array, b: Uint8Array) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;

/** Luma at (x, y). */
const at = (f: Uint8Array, x: number, y: number) => f[Math.round(y) * W + Math.round(x)];

describe("the shaped transitions", () => {
  test("the bundled ffmpeg is there", () => {
    expect(existsSync(FFMPEG)).toBe(true);
  });

  test("the clock wipe sweeps a wedge from the top edge down to the left one", () => {
    // A quarter of the way in, a point just under the top edge is uncovered
    // and one by the left edge is not.
    const f = canvasFrame("clockwipe", 0.25);
    expect(at(f, W - 2, 3)).toBeLessThan(40);
    expect(at(f, 2, H - 3)).toBeGreaterThan(215);
    const done = canvasFrame("clockwipe", 1);
    expect(at(done, 2, H - 3)).toBeLessThan(40);
  });

  test("a horizontal slice slides the top half left and the bottom half right", () => {
    // Midway the incoming shot shows at the right of the top half and the
    // left of the bottom half.
    const f = canvasFrame("sliceleft", 0.5);
    expect(at(f, W - 3, H / 4)).toBeLessThan(40);
    expect(at(f, 3, H / 4)).toBeGreaterThan(215);
    expect(at(f, 3, (3 * H) / 4)).toBeLessThan(40);
    expect(at(f, W - 3, (3 * H) / 4)).toBeGreaterThan(215);
  });

  test("a vertical slice brings the left column up from below and the right one down from above", () => {
    const f = canvasFrame("sliceup", 0.5);
    expect(at(f, W / 4, H - 3)).toBeLessThan(40);
    expect(at(f, W / 4, 3)).toBeGreaterThan(215);
    expect(at(f, (3 * W) / 4, 3)).toBeLessThan(40);
    expect(at(f, (3 * W) / 4, H - 3)).toBeGreaterThan(215);
  });

  test("a slice holds back, whips through the middle and settles long", () => {
    // The curve the reference's slice bars trace: a quarter of the move by
    // 0.385 of the way, three quarters by 0.6, the last tenth over the final
    // fifth.
    expect(shapeEase("sliceup", 0.3)).toBeLessThan(0.17);
    expect(shapeEase("sliceup", 0.385)).toBeCloseTo(0.25, 2);
    expect(shapeEase("sliceleft", 0.6)).toBeGreaterThan(0.75);
    expect(shapeEase("sliceleft", 0.8)).toBeLessThan(0.97);
    expect(shapeEase("sliceup", 0)).toBe(0);
    expect(shapeEase("sliceup", 1)).toBe(1);

    // The streak's speed is the slope of that curve.
    for (let p = 0.02; p < 1; p += 0.05) {
      const slope = (shapeEase("sliceup", p + 1e-5) - shapeEase("sliceup", p - 1e-5)) / 2e-5;
      expect(sliceSpeed(p)).toBeCloseTo(slope, 3);
    }
  });

  test("a feathered split opens as a soft band", () => {
    const f = canvasFrame("splitopen", 0.5, 0.2);
    // Black at the center, white at the edges, grays between.
    expect(at(f, W / 2, H / 2)).toBeLessThan(40);
    expect(at(f, 1, H / 2)).toBeGreaterThan(215);
    const row = [...Array(W).keys()].map((x) => at(f, x, H / 2));
    expect(row.filter((v) => v > 40 && v < 215).length).toBeGreaterThan(6);
  });

  const cases: [TransitionStyle, number | undefined][] = [
    ["clockwipe", undefined],
    ["sliceleft", undefined],
    ["sliceup", undefined],
    ["splitopen", 0.2],
    ["wipeleft", 0.15],
    ["circleclose", 0.1],
  ];
  for (const [style, feather] of cases) {
    test(`${style}${feather ? ` feathered ${feather}` : ""} renders the same frames in ffmpeg`, () => {
      const frames = ffmpegFrames(style, feather);
      for (let n = 1; n < FRAMES; n += 2) {
        const diff = meanDiff(canvasFrame(style, n / FRAMES, feather), frames[n]);
        expect(diff).toBeLessThan(4);
      }
    });
  }
});
