import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { Canvas } from "skia-canvas";
import { TEST_FFMPEG } from "./testing/ffmpeg";
import { applyEffectToCanvas, burnAt, effectFilterLines, effectPreviewState, effectRecipe } from "./effects";

/**
 * The char, a light leak's fifth course: the film burn's climb in dark
 * stock — a hot orange front rises from the bottom edge, cools through ember
 * to char black and hands the picture back. The handover out of a black
 * card in a recap opener. The canvas pass and the ffmpeg graph draw the same
 * frames.
 */

const W = 36;
const H = 64;
const FRAMES = 8;
const DUR = FRAMES / 30;

function white(): HTMLCanvasElement {
  const c = new Canvas(W, H) as unknown as HTMLCanvasElement;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  return c;
}

function canvasFrame(t: number): Uint8ClampedArray {
  const c = white();
  applyEffectToCanvas(c, white(), "char", 1, t, () => null, undefined, undefined, DUR);
  return c.getContext("2d")!.getImageData(0, 0, W, H).data;
}

const rgbAt = (d: Uint8ClampedArray, x: number, y: number) => Array.from(d.subarray((y * W + x) * 4, (y * W + x) * 4 + 3));

describe("the char", () => {
  test("a light leak on its char course renders the char", () => {
    expect(effectRecipe({ effect: "lightleak", leak: "char" })).toBe("char");
  });

  test("it climbs as the burn does, and plays across the element's own length", () => {
    const char = effectPreviewState("char", 1, 0.1, undefined, undefined, 1).burn!;
    expect(char.stops.map((s) => [s.at, s.a])).toEqual(burnAt(0.1, 1, 1).stops.map((s) => [s.at, s.a]));
  });

  test("early on a hot orange front has caught the bottom; the top still shows the picture", () => {
    const d = canvasFrame(DUR * 0.12);
    const [r, g, b] = rgbAt(d, W / 2, H - 2);
    expect(r).toBeGreaterThan(200);
    expect(r - b).toBeGreaterThan(150);
    expect(g).toBeLessThan(170);
    expect(rgbAt(d, W / 2, 1)).toEqual([255, 255, 255]);
  });

  test("it cools to char black, never a pale flare, and the picture comes back at the end", () => {
    for (let i = 0; i <= 20; i++) {
      const paint = effectPreviewState("char", 1, (i / 20) * DUR, undefined, undefined, DUR).burn!;
      for (const s of paint.stops) expect(s.rgb[2]).toBeLessThan(60);
    }
    const late = canvasFrame(DUR * 0.8);
    expect(Math.max(...rgbAt(late, W / 2, H / 2))).toBeLessThan(50);
    expect(effectPreviewState("char", 1, DUR, undefined, undefined, DUR).burn!.alpha).toBe(0);
  });

  test("the ffmpeg recipe draws the same frames", () => {
    const chroma = { pixFmt: "yuv444p", overlay: ":format=yuv444" };
    const lines = effectFilterLines("in", "out", "char", 1, 0, DUR, W, H, "t", undefined, undefined, chroma)!;
    const graph = `color=c=white:s=${W}x${H}:r=30:d=${DUR},format=yuv444p[in];${lines.join(";")}`;
    const run = spawnSync(TEST_FFMPEG, ["-v", "error", "-filter_complex", graph, "-map", "[out]", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]);
    expect(run.stderr.toString()).toBe("");
    expect(run.status).toBe(0);
    for (let i = 0; i < FRAMES; i++) {
      const ref = canvasFrame(i / 30);
      let sum = 0;
      let n = 0;
      for (let y = 1; y < H; y += 3) {
        for (let x = 1; x < W; x += 3) {
          const at = (i * W * H + y * W + x) * 3;
          const ours = Array.from(run.stdout.subarray(at, at + 3));
          rgbAt(ref, x, y).forEach((v, c) => {
            sum += Math.abs(ours[c] - v);
            n++;
          });
        }
      }
      // The export blends the burn in YUV and the canvas in RGB, so the
      // front's glow over a white picture lands a few codes apart.
      expect(sum / n).toBeLessThan(10);
    }
  });
});
