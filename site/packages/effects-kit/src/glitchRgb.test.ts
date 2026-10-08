import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { Canvas } from "skia-canvas";
import { TEST_FFMPEG } from "./testing/ffmpeg";
import { applyEffectToCanvas, effectFilterLines, effectPreviewState, effectRecipe, glitchHitAt } from "./effects";

/**
 * A glitch pinned to one kind hits with it on every frame, and its rgb kind
 * pulls a white bar apart: the channel moved up shows alone over the bar, the
 * one moved down alone under it, in the canvas pass and the ffmpeg graph.
 */

const S = 270;

// The split draws its channels on a kit-made plane; this file lends the kit
// skia's canvas as its OffscreenCanvas and hands the global back after.
const lent = globalThis.OffscreenCanvas;
beforeAll(() => {
  (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = Canvas;
});
afterAll(() => {
  (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = lent;
});
const BAR_TOP = 120;
const BAR_BOTTOM = 150;

/** Black with a full-width white bar across rows [120, 150). */
function barred(): HTMLCanvasElement {
  const c = new Canvas(S, S) as unknown as HTMLCanvasElement;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, BAR_TOP, S, BAR_BOTTOM - BAR_TOP);
  return c;
}

/** The channel moved up and the one moved down, by the first step's offset. */
function sides(): { up: number; down: number; d: number } {
  const rgb = effectPreviewState("glitch:rgb", 1, 0).rgb!;
  const d = Math.round((rgb.dy * S) / 1080);
  // Red moves by the offset, blue by its opposite: channel 0 is red, 2 blue.
  return d > 0 ? { up: 2, down: 0, d } : { up: 0, down: 2, d: -d };
}

describe("a pinned glitch", () => {
  test("a glitch with a kind renders that kind's recipe; other effects ignore it", () => {
    expect(effectRecipe({ effect: "glitch", glitch: "rgb" })).toBe("glitch:rgb");
    expect(effectRecipe({ effect: "glitch" })).toBe("glitch");
    expect(effectRecipe({ effect: "flash", glitch: "rgb" })).toBe("flash");
  });

  test("it hits on every step, where the random mix leaves clean ones", () => {
    const steps = [...Array(60).keys()];
    expect(steps.every((n) => glitchHitAt(n, 1, "rgb")?.kind === "rgb")).toBe(true);
    expect(steps.some((n) => glitchHitAt(n, 1) === null)).toBe(true);
    expect([...Array(3000).keys()].some((n) => glitchHitAt(n, 1)?.kind === "rgb")).toBe(false);
  });

  test("the canvas pass splits the bar: one channel alone over it, the other under it", () => {
    const { up, down, d } = sides();
    expect(d).toBeGreaterThanOrEqual(3);
    const c = barred();
    applyEffectToCanvas(c, barred(), "glitch:rgb", 1, 0, () => null);
    const px = (y: number) => Array.from(c.getContext("2d")!.getImageData(S / 2, y, 1, 1).data);
    const over = px(BAR_TOP - 2);
    const under = px(BAR_BOTTOM + 1);
    expect(over[up]).toBeGreaterThan(200);
    expect(over[down]).toBeLessThan(40);
    expect(under[down]).toBeGreaterThan(200);
    expect(under[up]).toBeLessThan(40);
  });

  test("split frames on one scratch draw on one plane", () => {
    // Count the planes the kit makes across a run of split frames.
    let made = 0;
    class Counted extends Canvas {
      constructor(w: number, h: number) {
        super(w, h);
        made++;
      }
    }
    (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = Counted;
    try {
      const scratch = barred();
      for (let i = 0; i < 3; i++) {
        applyEffectToCanvas(barred(), scratch, "glitch:rgb", 1, i / 30, () => null);
      }
      expect(made).toBe(1);
    } finally {
      (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = Canvas;
    }
  });

  test("the ffmpeg recipe splits the same way in ffmpeg", () => {
    const bin = TEST_FFMPEG;
    const { up, down } = sides();
    const lines = effectFilterLines("in", "out", "glitch:rgb", 1, 0, 0.2, S, S, "t")!;
    const graph =
      `color=c=black:s=${S}x${S}:r=30:d=0.1,format=yuv444p,` +
      `drawbox=x=0:y=${BAR_TOP}:w=${S}:h=${BAR_BOTTOM - BAR_TOP}:color=white:t=fill[in];${lines.join(";")}`;
    const run = spawnSync(bin, ["-v", "error", "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    expect(run.status).toBe(0);
    const px = (y: number) => Array.from(run.stdout.subarray((y * S + S / 2) * 3, (y * S + S / 2) * 3 + 3));
    const over = px(BAR_TOP - 2);
    const under = px(BAR_BOTTOM + 1);
    expect(over[up]).toBeGreaterThan(200);
    expect(over[down]).toBeLessThan(40);
    expect(under[down]).toBeGreaterThan(200);
    expect(under[up]).toBeLessThan(40);
  });
});
