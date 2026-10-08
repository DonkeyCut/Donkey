import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Canvas } from "skia-canvas";
import { applyClipEffects, applyEffectToCanvas, effectFilterLines, effectPreviewState } from "./effects";

// The black strobe: a flash held dark for the first half of every pulse.
const STROBE = { tone: "black", rate: 5 } as const;

describe("the flash strobe", () => {
  test("holds its tone for the first half of each pulse, then shows the picture", () => {
    // At 5 pulses a second a pulse is 0.2s: dark through 0.1s, lit to 0.2s.
    const on = effectPreviewState("flash", 1, 0.05, undefined, undefined, 2, STROBE);
    const off = effectPreviewState("flash", 1, 0.15, undefined, undefined, 2, STROBE);
    const again = effectPreviewState("flash", 1, 0.25, undefined, undefined, 2, STROBE);
    expect(on.flashTone).toBe("black");
    expect(on.flash).toBeCloseTo(0.85);
    expect(off.flash ?? 0).toBe(0);
    expect(again.flash).toBeCloseTo(0.85);
  });

  test("with no rate it is the single pop, and white carries no tone", () => {
    const pop = effectPreviewState("flash", 1, 0.5, undefined, undefined, 2, { tone: "black" });
    const early = effectPreviewState("flash", 1, 0.02, undefined, undefined, 2, { tone: "black" });
    expect(early.flash!).toBeGreaterThan(pop.flash!);
    expect(effectPreviewState("flash", 1, 0.02).flashTone).toBeUndefined();
  });

  test("the canvas pass paints black on a dark beat", () => {
    const W = 8;
    const grey = () => {
      const c = new Canvas(W, W) as unknown as HTMLCanvasElement;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#808080";
      ctx.fillRect(0, 0, W, W);
      return c;
    };
    const lum = (c: HTMLCanvasElement) => c.getContext("2d")!.getImageData(4, 4, 1, 1).data[0];
    const dark = grey();
    applyEffectToCanvas(dark, grey(), "flash", 1, 0.05, () => null, undefined, undefined, 2, "opaque", STROBE);
    const lit = grey();
    applyEffectToCanvas(lit, grey(), "flash", 1, 0.15, () => null, undefined, undefined, 2, "opaque", STROBE);
    expect(lum(dark)).toBeLessThan(30);
    expect(lum(lit)).toBe(128);
  });

  test("the ffmpeg recipe strobes the same frames in the bundled LGPL build", () => {
    const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../vendor/donkey-tools/ffmpeg");
    expect(existsSync(bin)).toBe(true);
    const lines = effectFilterLines("in", "out", "flash", 1, 0, 1, 64, 64, "t", undefined, undefined, undefined, STROBE)!;
    const graph = `color=c=0x808080:s=64x64:r=30:d=0.4,format=yuv420p[in];${lines.join(";")}`;
    const run = spawnSync(bin, [
      "-v", "error", "-filter_complex", graph, "-map", "[out]", "-f", "rawvideo", "-pix_fmt", "gray", "-",
    ]);
    expect(run.status).toBe(0);
    // One luma sample per frame: frames 0–2 sit in the first dark half
    // (0..0.1s), frames 3–5 in the lit half.
    const frames = [...Array(12).keys()].map((i) => run.stdout[i * 64 * 64 + 32 * 64 + 32]);
    expect(frames[0]).toBeLessThan(40);
    expect(frames[2]).toBeLessThan(40);
    expect(frames[4]).toBeGreaterThan(100);
    expect(frames[7]).toBeLessThan(40);
  });
});

describe("the fastest strobe", () => {
  // At 15 pulses a second a 30 fps cut is one frame dark, one frame lit, so
  // every frame lands on a pulse's edge: the clip here starts mid-timeline,
  // where the frame times carry rounding.
  const FAST = { tone: "black", rate: 15 } as const;
  const START = 3.5;
  const N = 12;

  test("alternates dark and lit frame by frame in the preview", () => {
    const dark = [...Array(N).keys()].map((n) => (effectPreviewState("flash", 1, (105 + n) / 30 - START, undefined, undefined, 1, FAST).flash ?? 0) > 0.5);
    expect(dark).toEqual([...Array(N).keys()].map((n) => n % 2 === 0));
  });

  test("alternates on the same frames in the bundled LGPL build", () => {
    const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../vendor/donkey-tools/ffmpeg");
    const lines = effectFilterLines("in", "out", "flash", 1, START, START + 1, 64, 64, "t", undefined, undefined, undefined, FAST)!;
    const graph = `color=c=0x808080:s=64x64:r=30:d=4.2,format=yuv420p[in];${lines.join(";")}`;
    const run = spawnSync(bin, ["-v", "error", "-filter_complex", graph, "-map", "[out]", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
    expect(run.status).toBe(0);
    const dark = [...Array(N).keys()].map((n) => run.stdout[(105 + n) * 64 * 64 + 32 * 64 + 32] < 60);
    expect(dark).toEqual([...Array(N).keys()].map((n) => n % 2 === 0));
  });
});

// The white flicker: one-frame pulses, each dealt its own strength.
const FLICKER = { rate: 15, rhythm: "flicker" } as const;
const FRAMES = 60;

describe("the flash flicker", () => {
  // The preview's strength on each frame's pulse.
  const preview = [...Array(FRAMES).keys()].map((i) => effectPreviewState("flash", 1, i / 30, undefined, undefined, 2, FLICKER).flash ?? 0);

  test("pops unevenly: some pulses dark, the rest at strengths of their own", () => {
    const lit = preview.filter((v) => v > 0);
    expect(lit.length).toBeGreaterThan(8);
    expect(lit.length).toBeLessThan(FRAMES / 2);
    expect(new Set(lit.map((v) => v.toFixed(2))).size).toBeGreaterThan(5);
  });

  test("a clip wearing it pops only its own opaque picture", () => {
    // A transparent canvas with a grey square: the clip inside its mask.
    const clip = () => {
      const c = new Canvas(8, 8) as unknown as HTMLCanvasElement;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#404040";
      ctx.fillRect(2, 2, 4, 4);
      return c;
    };
    const frame = preview.findIndex((v) => v > 0.5);
    const c = clip();
    applyClipEffects(c, clip(), [{ effect: "flash", amount: 1, ...FLICKER }], frame / 30, () => null);
    const px = (x: number, y: number) => c.getContext("2d")!.getImageData(x, y, 1, 1).data;
    expect(px(4, 4)[0]).toBeGreaterThan(0x40 + 60);
    expect(px(0, 0)[3]).toBe(0);
  });

  test("the ffmpeg recipe lights the same frames in the bundled LGPL build", () => {
    const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../vendor/donkey-tools/ffmpeg");
    const lines = effectFilterLines("in", "out", "flash", 1, 0, 2, 64, 64, "t", undefined, undefined, undefined, FLICKER)!;
    const graph = `color=c=0x202020:s=64x64:r=30:d=${FRAMES / 30},format=yuv420p[in];${lines.join(";")}`;
    const run = spawnSync(bin, ["-v", "error", "-filter_complex", graph, "-map", "[out]", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
    expect(run.status).toBe(0);
    const base = run.stdout[32 * 64 + 32 + 64 * 64 * preview.findIndex((v) => v === 0)];
    const frames = [...Array(FRAMES).keys()].map((i) => run.stdout[i * 64 * 64 + 32 * 64 + 32] - base);
    // Lit exactly where the preview lights, brighter where it deals more.
    for (let i = 0; i < FRAMES; i++) {
      expect(frames[i] > 8).toBe(preview[i] > 0);
    }
    const order = (xs: number[]) => xs.map((_, i) => i).filter((i) => preview[i] > 0).sort((a, b) => xs[a] - xs[b]);
    expect(order(frames)[order(frames).length - 1]).toBe(order(preview)[order(preview).length - 1]);
  });
});
