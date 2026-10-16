import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Canvas } from "skia-canvas";
import { FrameCompositor, type Frame } from "./composite";
import { setRasterFactory, type RasterFactory, type RasterSurface } from "./raster";
import { bandEdge, clampBand, takesBand } from "./transitionShape";
import { xfadeTransition } from "../server/transitionExpr";
import type { TransitionStyle, VideoClip } from "./types";

/**
 * A wipe with a band: a solid white panel runs just ahead of the reveal
 * edge, so the outgoing shot is wiped first by white and then by the
 * incoming shot — the white-panel slide of a recap montage. A gray shot
 * hands over to a black one, compared on the compositor's canvas and in
 * the ffmpeg export's xfade expression.
 */

const W = 160;
const H = 90;
const FPS = 30;
const SECONDS = 0.5;
const FRAMES = Math.round(SECONDS * FPS);
const BUNDLED_FFMPEG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../vendor/donkey-tools/ffmpeg");
const FFMPEG = existsSync(BUNDLED_FFMPEG) ? BUNDLED_FFMPEG : "ffmpeg";

// The suite shares one raster seam, so the skia factory comes out after this
// file: left in, later files measure and draw with it.
let restore: RasterFactory | undefined;
beforeAll(() => {
  restore = setRasterFactory({
    createCanvas: (w, h) => new Canvas(w, h) as unknown as RasterSurface,
    decodeImage: async () => null,
    canvasToBlob: async () => new Blob(),
    snapshot: async (canvas) => canvas as unknown as ImageBitmap,
  });
});
afterAll(() => {
  if (restore) {
    setRasterFactory(restore);
  }
});

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

function canvasFrame(style: TransitionStyle, p: number, band: number): Uint8Array {
  const canvas = new Canvas(W, H);
  const comp = new FrameCompositor(canvas as unknown as HTMLCanvasElement);
  comp.drawCrossJoin(
    style,
    p,
    {
      masterFrame: solid("#808080"),
      masterClip: clipOf({ transitionStyle: style, transitionBand: band }),
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
  for (let i = 0; i < W * H; i++) out[i] = rgba[i * 4];
  return out;
}

function ffmpegFrames(style: TransitionStyle, band: number): Uint8Array[] {
  const opt = xfadeTransition(style, undefined, SECONDS, W, H, band);
  const graph =
    `color=c=0x808080:s=${W}x${H}:r=${FPS}:d=${SECONDS},format=yuv420p[a];` +
    `color=c=black:s=${W}x${H}:r=${FPS}:d=${SECONDS * 2},format=yuv420p[b];` +
    `[a][b]xfade=${opt}:duration=${SECONDS}:offset=0,format=gray[out]`;
  const run = spawnSync(FFMPEG, ["-v", "error", "-filter_complex", graph, "-map", "[out]", "-frames:v", String(FRAMES), "-f", "rawvideo", "-"]);
  expect(run.stderr.toString()).toBe("");
  expect(run.status).toBe(0);
  // The band is the limited-range white code, which this raw gray readout
  // leaves at 235 where the canvas reads 255.
  return [...Array(FRAMES).keys()].map((n) =>
    new Uint8Array(run.stdout.subarray(n * W * H, (n + 1) * W * H)).map((v) => (v >= 230 ? 255 : v))
  );
}

const meanDiff = (a: Uint8Array, b: Uint8Array) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
const at = (f: Uint8Array, x: number, y: number) => f[Math.round(y) * W + Math.round(x)];

describe("a wipe's white band", () => {
  test("wipes take a band, other styles don't, and it is clamped", () => {
    expect(takesBand("wiperight")).toBe(true);
    expect(takesBand("crossfade")).toBe(false);
    expect(clampBand(2)).toBe(0.5);
    expect(clampBand(-1)).toBe(0);
  });

  test("the band enters off-frame, crosses, and leaves off-frame", () => {
    expect(bandEdge(0, 0.25)).toBeCloseTo(-0.25, 6);
    expect(bandEdge(1, 0.25)).toBeCloseTo(1, 6);
    expect(bandEdge(0.5, 0.25)).toBeCloseTo(0.375, 6);
  });

  test("mid-wipe: incoming behind the edge, white ahead of it, outgoing past the band", () => {
    const f = canvasFrame("wiperight", 0.5, 0.25);
    expect(at(f, 0.2 * W, H / 2)).toBeLessThan(10);
    expect(at(f, 0.5 * W, H / 2)).toBeGreaterThan(245);
    expect(Math.abs(at(f, 0.8 * W, H / 2) - 128)).toBeLessThan(6);
    const up = canvasFrame("wipeup", 0.5, 0.25);
    expect(at(up, W / 2, 0.8 * H)).toBeLessThan(10);
    expect(at(up, W / 2, 0.5 * H)).toBeGreaterThan(245);
    expect(Math.abs(at(up, W / 2, 0.2 * H) - 128)).toBeLessThan(6);
  });

  for (const style of ["wiperight", "wipeleft", "wipedown"] as TransitionStyle[]) {
    test(`${style} with a band renders the same frames in ffmpeg`, () => {
      const frames = ffmpegFrames(style, 0.3);
      for (let n = 1; n < FRAMES; n += 2) {
        expect(meanDiff(canvasFrame(style, n / FRAMES, 0.3), frames[n])).toBeLessThan(6);
      }
    });
  }
});
