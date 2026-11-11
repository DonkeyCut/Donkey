import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { Canvas } from "skia-canvas";
import { TEST_FFMPEG } from "./testing/ffmpeg";
import { applyEffectToCanvas, effectFilterLines } from "./effects";

/**
 * The light leak's drift course: a warm bloom near the top-left corner and
 * soft streak bands over the picture. The export graph lays the same light
 * over the footage the preview does, and every pixel keeps the footage under
 * it, the far corner included.
 */

const S = 64;
const FRAMES = 4;
const DUR = 0.8;
const GREY = 128;

function grey(): HTMLCanvasElement {
  const c = new Canvas(S, S) as unknown as HTMLCanvasElement;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = `rgb(${GREY},${GREY},${GREY})`;
  ctx.fillRect(0, 0, S, S);
  return c;
}

function canvasFrame(t: number): Uint8ClampedArray {
  const c = grey();
  applyEffectToCanvas(c, grey(), "lightleak", 0.5, t, () => null, undefined, undefined, DUR);
  return c.getContext("2d")!.getImageData(0, 0, S, S).data;
}

const rgbAt = (d: Uint8ClampedArray, x: number, y: number) => Array.from(d.subarray((y * S + x) * 4, (y * S + x) * 4 + 3));

describe("the drifting light leak", () => {
  test("the ffmpeg recipe lights the footage the way the preview does", () => {
    // Grey footage under a half-amount leak, as a template lays it over a cut.
    const lines = effectFilterLines("in", "out", "lightleak", 0.5, 0, DUR, S, S, "t")!;
    const graph = `color=c=0x808080:s=${S}x${S}:r=30:d=${FRAMES / 30},format=yuv420p[in];${lines.join(";")}`;
    const run = spawnSync(TEST_FFMPEG, ["-v", "error", "-filter_complex", graph, "-map", "[out]", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]);
    expect(run.stderr.toString()).toBe("");
    expect(run.status).toBe(0);

    // Every sampled pixel lands near the preview's, so no part of the frame
    // blows out or drops to black.
    let worst = 0;
    for (let i = 0; i < FRAMES; i++) {
      const ref = canvasFrame(i / 30);
      const base = i * S * S * 3;
      for (let y = 2; y < S; y += 4) {
        for (let x = 2; x < S; x += 4) {
          const at = base + (y * S + x) * 3;
          const ours = Array.from(run.stdout.subarray(at, at + 3));
          rgbAt(ref, x, y).forEach((v, c) => {
            worst = Math.max(worst, Math.abs(ours[c] - v));
          });
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(40);
  });
});
