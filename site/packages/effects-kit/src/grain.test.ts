import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { Canvas } from "skia-canvas";
import { TEST_FFMPEG } from "./testing/ffmpeg";
import { applyEffectToCanvas, effectFilterLines, effectPreviewState, EFFECT_IDS, grainTile, LOOK_IDS, lookFilterLines } from "./index";

/**
 * Film grain is one model in the canvas and the ffmpeg graph: monochrome
 * gaussian clumps a fixed share of the frame, overlay-blended so they hold in
 * the midtones, fresh every frame, and none at amount 0.
 */

// The tiles are kit-made planes; this file lends the kit skia's canvas as its
// OffscreenCanvas and hands the global back after.
const lent = globalThis.OffscreenCanvas;
beforeAll(() => {
  (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = Canvas;
});
afterAll(() => {
  (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = lent;
});

const hasFfmpeg = spawnSync(TEST_FFMPEG, ["-version"], { stdio: "ignore" }).status === 0;

/** The gray levels of the ramp: black, the midtones, white. */
const BANDS = [0, 64, 128, 192, 255];

/** An RGB24 frame of vertical gray bands, one per level. */
function bandFrame(w: number, h: number, levels: number[]): Uint8Array {
  const px = new Uint8Array(w * h * 3);
  const bw = w / levels.length;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      px.fill(levels[Math.min(levels.length - 1, Math.floor(x / bw))], (y * w + x) * 3, (y * w + x) * 3 + 3);
    }
  }
  return px;
}

/** One frame through the export: RGB24 in, the effect's lines in the chain's
 * format, raw `outFmt` bytes out. */
function exportFrame(rgb: Uint8Array, w: number, h: number, effect: string, amount: number | null, chain = "yuv420p", outFmt = "rgb24"): Uint8Array {
  const lines = amount === null ? [`[src]null[out]`] : effectFilterLines("src", "out", effect, amount, 0, 10, w, h, "t", undefined, undefined, { pixFmt: chain, overlay: "", depth: chain.includes("10") ? 10 : 8 })!;
  const graph = [`[0:v]format=${chain}[src]`, ...lines].join(";");
  const run = spawnSync(TEST_FFMPEG, [
    "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${w}x${h}`, "-r", "30", "-i", "-",
    "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", outFmt, "-",
  ], { input: rgb, maxBuffer: 1 << 28 });
  if (run.status !== 0) {
    throw new Error(run.stderr.toString());
  }
  return new Uint8Array(run.stdout);
}

/** One frame through the canvas pass at `t`. */
function canvasFrame(rgb: Uint8Array, w: number, h: number, amount: number, t = 0.5): Uint8Array {
  const c = new Canvas(w, h);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(w, h);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    img.data[j] = rgb[i];
    img.data[j + 1] = rgb[i + 1];
    img.data[j + 2] = rgb[i + 2];
    img.data[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const surface = c as unknown as HTMLCanvasElement;
  applyEffectToCanvas(surface, new Canvas(w, h) as unknown as HTMLCanvasElement, "grain", amount, t, grainTile);
  const out = ctx.getImageData(0, 0, w, h).data;
  const px = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; j < out.length; i += 3, j += 4) {
    px[i] = out[j];
    px[i + 1] = out[j + 1];
    px[i + 2] = out[j + 2];
  }
  return px;
}

/** One channel of a packed frame over band `n`'s inner area (a margin keeps
 * the band edges out). */
function bandValues(px: Uint8Array, w: number, h: number, n: number, step: number, levels = BANDS.length): number[] {
  const bw = w / levels;
  const vals: number[] = [];
  for (let y = 8; y < h - 8; y++) {
    for (let x = Math.ceil(n * bw) + 8; x < (n + 1) * bw - 8; x++) {
      vals.push(px[(y * w + x) * step + (step > 1 ? 1 : 0)]);
    }
  }
  return vals;
}

function stdDev(vals: number[]): number {
  const mean = vals.reduce((a, v) => a + v, 0) / vals.length;
  return Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length);
}

/** How alike each pixel is to its right neighbor, over a whole gray plane:
 * near 0 for single-pixel noise, toward 1 as grains span more pixels. */
function lagOne(plane: Uint8Array, w: number, h: number, step: number): number {
  let n = 0;
  let mean = 0;
  for (let i = 0; i < w * h; i++) {
    mean += plane[i * step];
  }
  mean /= w * h;
  let cov = 0;
  let v = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      const a = plane[(y * w + x) * step] - mean;
      const b = plane[(y * w + x + 1) * step] - mean;
      cov += a * b;
      v += a * a;
      n++;
    }
  }
  return n ? cov / v : 0;
}

describe("film grain in the preview", () => {
  test("its strength runs from zero, a straight share of the amount", () => {
    expect(effectPreviewState("grain", 0, 0).grain ?? 0).toBe(0);
    const half = effectPreviewState("grain", 0.5, 0).grain!;
    expect(effectPreviewState("grain", 1, 0).grain!).toBeCloseTo(2 * half, 6);
  });

  test("its grains are a share of the frame, so a bigger frame wears bigger grains", () => {
    const mid = (w: number, h: number) => lagOne(canvasFrame(bandFrame(w, h, [128]), w, h, 1), w, h, 3);
    expect(mid(2560, 1440)).toBeGreaterThan(mid(1280, 720) + 0.15);
  });

  test("every frame wears fresh grain, and the same moment the same grain", () => {
    const ramp = bandFrame(320, 180, [128]);
    const a = canvasFrame(ramp, 320, 180, 1, 2);
    expect(canvasFrame(ramp, 320, 180, 1, 2)).toEqual(a);
    expect(canvasFrame(ramp, 320, 180, 1, 2 + 1 / 60)).not.toEqual(a);
  });
});

describe("film grain in the export", () => {
  test("its noise is temporal gaussian", () => {
    const graph = effectFilterLines("a", "b", "grain", 0.5, 0, 4, 1920, 1080, "t")!.join(";");
    expect(graph).toContain("c0f=t:");
    expect(graph).not.toMatch(/f=[a-z+]*u/);
  });

  test.skipIf(!hasFfmpeg)("at amount 0 the picture is untouched", () => {
    const ramp = bandFrame(320, 180, BANDS);
    expect(exportFrame(ramp, 320, 180, "grain", 0)).toEqual(exportFrame(ramp, 320, 180, "grain", null));
  });

  test.skipIf(!hasFfmpeg)("it falls on luma alone and leaves the chroma as it was", () => {
    const w = 320;
    const h = 180;
    const orange = new Uint8Array(w * h * 3);
    for (let i = 0; i < orange.length; i += 3) {
      orange.set([200, 120, 60], i);
    }
    const out = exportFrame(orange, w, h, "grain", 1, "yuv420p", "yuv420p");
    const ref = exportFrame(orange, w, h, "grain", null, "yuv420p", "yuv420p");
    expect(out.subarray(w * h)).toEqual(ref.subarray(w * h));
    expect(stdDev(Array.from(out.subarray(0, w * h)))).toBeGreaterThan(4);
  });

  test.skipIf(!hasFfmpeg)("it holds in the midtones and takes nothing in black and white", () => {
    const w = 640;
    const h = 360;
    const out = exportFrame(bandFrame(w, h, BANDS), w, h, "grain", 0.5);
    const sd = BANDS.map((_, n) => stdDev(bandValues(out, w, h, n, 3)));
    expect(sd[2]).toBeGreaterThan(6);
    expect(sd[0]).toBeLessThan(1);
    expect(sd[4]).toBeLessThan(1);
    expect(sd[1]).toBeLessThan(sd[2]);
    expect(sd[3]).toBeLessThan(sd[2]);
  });

  test.skipIf(!hasFfmpeg)("its grains are a share of the frame, so a bigger frame wears bigger grains", () => {
    const mid = (w: number, h: number) => lagOne(exportFrame(bandFrame(w, h, [128]), w, h, "grain", 1, "yuv420p", "gray"), w, h, 1);
    const small = mid(1280, 720);
    expect(small).toBeGreaterThan(0.1);
    expect(mid(2560, 1440)).toBeGreaterThan(small + 0.15);
  });

  test.skipIf(!hasFfmpeg)("it grains every chain format alike", () => {
    const w = 640;
    const h = 360;
    const ramp = bandFrame(w, h, BANDS);
    for (const chain of ["yuv420p", "yuv444p", "yuva420p", "yuv420p10le", "yuva444p10le", "rgba"]) {
      const out = exportFrame(ramp, w, h, "grain", 0.5, chain);
      const sd = BANDS.map((_, n) => stdDev(bandValues(out, w, h, n, 3)));
      expect(sd[0]).toBeLessThan(1);
      expect(sd[4]).toBeLessThan(1);
      expect(sd[2]).toBeGreaterThan(15);
      expect(sd[2]).toBeLessThan(20);
    }
  });

  test.skipIf(!hasFfmpeg)("it renders in every chain format and keeps the clip's frames", () => {
    for (const chain of ["yuv444p", "yuva420p", "yuv420p10le", "yuva444p10le", "rgba"]) {
      const lines = effectFilterLines("src", "out", "grain", 0.5, 0, 10, 160, 90, "t", undefined, undefined, { pixFmt: chain, overlay: "", depth: chain.includes("10") ? 10 : 8 })!;
      const run = spawnSync(TEST_FFMPEG, [
        "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=160x90:r=30:d=1",
        "-filter_complex", [`[0:v]format=${chain}[src]`, ...lines].join(";"), "-map", "[out]", "-f", "framecrc", "-",
      ]);
      expect(run.status).toBe(0);
      expect(run.stdout.toString().trim().split("\n").filter((l) => !l.startsWith("#")).length).toBe(30);
    }
  });
});

describe("film grain is one model", () => {
  test.skipIf(!hasFfmpeg)("the canvas and the export grain a gray ramp alike", () => {
    const w = 1920;
    const h = 1080;
    const ramp = bandFrame(w, h, BANDS);
    const canvas = canvasFrame(ramp, w, h, 0.5);
    const ff = exportFrame(ramp, w, h, "grain", 0.5);
    const sdC = BANDS.map((_, n) => stdDev(bandValues(canvas, w, h, n, 3)));
    const sdF = BANDS.map((_, n) => stdDev(bandValues(ff, w, h, n, 3)));
    for (const n of [1, 2, 3]) {
      expect(Math.abs(sdF[n] - sdC[n]) / sdC[n]).toBeLessThan(0.15);
    }
    for (const n of [0, 4]) {
      expect(sdC[n]).toBeLessThan(1);
      expect(sdF[n]).toBeLessThan(1);
    }
  });

  test("only VHS wears tape static", () => {
    for (const id of EFFECT_IDS) {
      const graph = (effectFilterLines("a", "b", id, 0.5, 0, 4, 1920, 1080, "t") ?? []).join(";");
      expect(graph.includes("noise=alls")).toBe(id === "vhs");
    }
    for (const id of LOOK_IDS) {
      const graph = (lookFilterLines("a", "b", id, 0.5, 1920, 1080, "yuv420p", "t") ?? []).join(";");
      expect(graph.includes("noise=alls")).toBe(id === "vhs");
    }
  });
});
