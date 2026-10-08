import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Canvas } from "skia-canvas";
import { applyEffectToCanvas, effectFilterLines, effectPreviewState, effectRecipe, type WashArea } from "./effects";

/**
 * The scorch maps each frame onto a hot tone by brightness: black lands on
 * the tone's deep color, white on its pale one. Some frames burn the whole
 * picture, others a patch of it, and the canvas pass and the ffmpeg graph
 * deal the same tone and the same patch to the same frame.
 */

const S = 64;
const FRAMES = 12;

/** Left half black, right half white. */
function halves(): HTMLCanvasElement {
  const c = new Canvas(S, S) as unknown as HTMLCanvasElement;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(S / 2, 0, S / 2, S);
  return c;
}

/** The patch frame `i` burns; none when it burns the whole picture. */
const areaAt = (i: number): WashArea | undefined => effectPreviewState("scorch", 1, i / 30).washes?.[0]?.area;

/** How far into the burn a pixel center sits: 1 inside the patch, 0 past
 * its rim, a ramp between. */
function cover(a: WashArea | undefined, x: number, y: number): number {
  if (!a) {
    return 1;
  }
  const q = Math.hypot(((x + 0.5) / S - a.x) / a.rx, ((y + 0.5) / S - a.y) / a.ry);
  return Math.max(0, Math.min(1, (1 - q) / (1 - a.inner)));
}

/** Every frame through the canvas pass, as RGBA rows. */
function canvasFrames(): Uint8ClampedArray[] {
  return [...Array(FRAMES).keys()].map((i) => {
    const c = halves();
    applyEffectToCanvas(c, halves(), "scorch", 1, i / 30, () => null);
    return c.getContext("2d")!.getImageData(0, 0, S, S).data;
  });
}

const rgbAt = (d: Uint8ClampedArray, x: number, y: number) => Array.from(d.subarray((y * S + x) * 4, (y * S + x) * 4 + 3));

describe("the scorch", () => {
  test("a light leak on its scorch course renders the scorch", () => {
    expect(effectRecipe({ effect: "lightleak", leak: "scorch" })).toBe("scorch");
  });

  test("burned pixels land on a saturated hot tone, a new tone some frames", () => {
    const frames = canvasFrames();
    const tones = new Set<string>();
    frames.forEach((d, i) => {
      const a = areaAt(i);
      for (let y = 0; y < S; y += 3) {
        for (let x = 0; x < S; x += 3) {
          if (cover(a, x, y) < 1) {
            continue;
          }
          const [r, g, b] = rgbAt(d, x, y);
          expect(r).toBeGreaterThan(140);
          expect(r - b).toBeGreaterThan(80);
          if (x < S / 2) {
            tones.add(`${r},${g},${b}`);
          }
        }
      }
    });
    expect(tones.size).toBeGreaterThan(1);
  });

  test("some frames burn only a patch, leaving the picture past its rim", () => {
    const frames = canvasFrames();
    const patched = frames.map((d, i) => ({ d, a: areaAt(i) })).filter((f) => f.a);
    expect(patched.length).toBeGreaterThan(0);
    expect(patched.length).toBeLessThan(FRAMES);
    let untouched = 0;
    for (const { d, a } of patched) {
      for (let y = 0; y < S; y += 2) {
        for (let x = 0; x < S; x += 2) {
          if (cover(a, x, y) > 0) {
            continue;
          }
          const want = x < S / 2 ? 0 : 255;
          rgbAt(d, x, y).forEach((v) => expect(Math.abs(v - want)).toBeLessThanOrEqual(1));
          untouched++;
        }
      }
    }
    expect(untouched).toBeGreaterThan(0);
  });

  test("a patch's rim fades white to the pale tone without dipping darker", () => {
    const frames = canvasFrames();
    let rims = 0;
    frames.forEach((d, i) => {
      const a = areaAt(i);
      if (!a) {
        return;
      }

      // The pale tone is any white pixel deep inside the patch.
      let pale: number[] | undefined;
      for (let y = 0; y < S && !pale; y++) {
        for (let x = S / 2; x < S && !pale; x++) {
          if (cover(a, x, y) === 1) {
            pale = rgbAt(d, x, y);
          }
        }
      }
      if (!pale) {
        return;
      }
      for (let y = 0; y < S; y++) {
        for (let x = S / 2; x < S; x++) {
          const k = cover(a, x, y);
          if (k <= 0 || k >= 1) {
            continue;
          }
          rgbAt(d, x, y).forEach((v, c) => expect(v).toBeGreaterThanOrEqual(pale![c] - 3));
          rims++;
        }
      }
    });
    expect(rims).toBeGreaterThan(0);
  });

  test("the ffmpeg recipe is one geq of one size whatever the length", () => {
    const graph = (d: number) => effectFilterLines("in", "out", "scorch", 1, 0, d, S, S, "t")!.join(";");
    expect(graph(1).match(/geq=/g)!.length).toBe(1);
    expect(graph(10).match(/geq=/g)!.length).toBe(1);
    expect(Math.abs(graph(10).length - graph(1).length)).toBeLessThan(40);
  });

  test("the ffmpeg recipe deals the same tones and patches in the bundled LGPL build", () => {
    const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../vendor/donkey-tools/ffmpeg");
    expect(existsSync(bin)).toBe(true);
    // A 4:4:4 chain, so the rims keep their color per pixel.
    const chroma = { pixFmt: "yuv444p", overlay: ":format=yuv444" };
    const lines = effectFilterLines("in", "out", "scorch", 1, 0, FRAMES / 30, S, S, "t", undefined, undefined, chroma)!;
    const graph =
      `color=c=black:s=${S}x${S}:r=30:d=${FRAMES / 30},format=yuv444p,` +
      `drawbox=x=${S / 2}:y=0:w=${S / 2}:h=${S}:color=white:t=fill[in];${lines.join(";")}`;
    const run = spawnSync(bin, ["-v", "error", "-filter_complex", graph, "-map", "[out]", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]);
    expect(run.status).toBe(0);
    const frames = canvasFrames();
    let checked = 0;
    for (let i = 0; i < FRAMES; i++) {
      const a = areaAt(i);
      const base = i * S * S * 3;
      for (let y = 1; y < S; y += 4) {
        for (let x = 1; x < S; x += 4) {
          // yuv444 round trips cost a few codes; the rims blend alike.
          const at = base + (y * S + x) * 3;
          const ours = Array.from(run.stdout.subarray(at, at + 3));
          rgbAt(frames[i], x, y).forEach((v, c) => expect(Math.abs(ours[c] - v)).toBeLessThanOrEqual(12));
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(FRAMES * 100);
  });
});
