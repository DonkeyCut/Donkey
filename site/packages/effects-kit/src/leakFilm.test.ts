import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { Canvas } from "skia-canvas";
import { TEST_FFMPEG } from "./testing/ffmpeg";
import { applyEffectToCanvas, effectFilterLines, effectPreviewState, effectRecipe } from "./effects";

/**
 * The film flash, a light leak's fourth course: for a few frames over a cut
 * the picture washes warm orange and the film strip's sprocket holes blaze
 * along the top edge, then everything hands back. The canvas pass and the
 * ffmpeg graph draw the same washes on the same frames.
 */

const S = 64;
const FRAMES = 6;
const DUR = FRAMES / 30;

function black(): HTMLCanvasElement {
  const c = new Canvas(S, S) as unknown as HTMLCanvasElement;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, S, S);
  return c;
}

function canvasFrame(t: number): Uint8ClampedArray {
  const c = black();
  applyEffectToCanvas(c, black(), "film", 1, t, () => null, undefined, undefined, DUR);
  return c.getContext("2d")!.getImageData(0, 0, S, S).data;
}

const rgbAt = (d: Uint8ClampedArray, x: number, y: number) => Array.from(d.subarray((y * S + x) * 4, (y * S + x) * 4 + 3));

describe("the film flash", () => {
  test("a light leak on its film course renders the film flash", () => {
    expect(effectRecipe({ effect: "lightleak", leak: "film" })).toBe("film");
  });

  test("it peaks mid-element and leaves the picture alone at its edges", () => {
    const edge = effectPreviewState("film", 1, 0, undefined, undefined, DUR);
    const mid = effectPreviewState("film", 1, DUR / 2, undefined, undefined, DUR);
    expect(Math.max(0, ...(edge.washes ?? []).map((w) => w.alpha))).toBeLessThan(0.05);
    expect(Math.max(...(mid.washes ?? []).map((w) => w.alpha))).toBeGreaterThan(0.8);
  });

  test("sprocket holes blaze along the top over a warm wash", () => {
    const d = canvasFrame(DUR / 2);
    const holes = effectPreviewState("film", 1, DUR / 2, undefined, undefined, DUR).washes!.filter((w) => w.area && w.area.y < 0.15);
    expect(holes.length).toBeGreaterThanOrEqual(3);
    for (const h of holes) {
      const [r, g, b] = rgbAt(d, Math.floor(h.area!.x * S), Math.floor(h.area!.y * S));
      expect(Math.min(r, g, b)).toBeGreaterThan(200);
    }
    // Between the holes and down the frame: warm, not white.
    const [r, g, b] = rgbAt(d, S / 2, Math.floor(S * 0.6));
    expect(r).toBeGreaterThan(110);
    expect(r - b).toBeGreaterThan(60);
    expect(b).toBeLessThan(150);
  });

  test("the ffmpeg recipe draws the same frames", () => {
    const chroma = { pixFmt: "yuv444p", overlay: ":format=yuv444" };
    const lines = effectFilterLines("in", "out", "film", 1, 0, DUR, S, S, "t", undefined, undefined, chroma)!;
    expect(lines).not.toBeNull();
    const graph = `color=c=black:s=${S}x${S}:r=30:d=${DUR},format=yuv444p[in];${lines.join(";")}`;
    const run = spawnSync(TEST_FFMPEG, ["-v", "error", "-filter_complex", graph, "-map", "[out]", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]);
    expect(run.stderr.toString()).toBe("");
    expect(run.status).toBe(0);
    let checked = 0;
    for (let i = 0; i < FRAMES; i++) {
      const ref = canvasFrame(i / 30);
      const base = i * S * S * 3;
      for (let y = 1; y < S; y += 4) {
        for (let x = 1; x < S; x += 4) {
          const at = base + (y * S + x) * 3;
          const ours = Array.from(run.stdout.subarray(at, at + 3));
          rgbAt(ref, x, y).forEach((v, c) => expect(Math.abs(ours[c] - v)).toBeLessThanOrEqual(12));
          checked++;
        }
      }
    }
    expect(checked).toBe(FRAMES * 256);
  });
});
