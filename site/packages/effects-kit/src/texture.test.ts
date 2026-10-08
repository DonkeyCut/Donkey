import { describe, expect, test } from "bun:test";
import { Canvas } from "skia-canvas";
import { planAnimatedLayers, renderElementCanvas, type RenderEnv } from "./render";
import { evalOverlayFrame } from "./keys";
import { stippleKeeps } from "./texture";
import type { TextOverlay } from "./types";

const env: RenderEnv = {
  fontStack: () => "Arial",
  createCanvas: (w, h) => new Canvas(w, h) as unknown as HTMLCanvasElement,
  canvasToPngBlob: async (c) => new Blob([new Uint8Array(await (c as unknown as Canvas).toBuffer("png"))]),
};

// One heavy block letter filling the middle of the frame.
const title = (over: Partial<TextOverlay> = {}): TextOverlay => ({
  id: "t",
  text: "M",
  start: 0,
  end: 2,
  x: 0.5,
  y: 0.5,
  size: 700,
  font: "sf",
  weight: 900,
  color: "#ffffff",
  shadow: false,
  plate: false,
  ...over,
});

/** The share of opaque pixels in a band of columns across the letter's ink. */
async function inkShare(o: TextOverlay, from: number, to: number): Promise<number> {
  const c = await renderElementCanvas(o, 1080, 1080, env);
  const data = c.getContext("2d")!.getImageData(0, 0, 1080, 1080).data;
  // The letter's own extent, read off the solid render.
  let left = 1080;
  let right = 0;
  const solid = (await renderElementCanvas({ ...o, texture: undefined }, 1080, 1080, env)).getContext("2d")!.getImageData(0, 0, 1080, 1080).data;
  for (let x = 0; x < 1080; x++) {
    if (solid[(540 * 1080 + x) * 4 + 3] > 128) {
      left = Math.min(left, x);
      right = Math.max(right, x);
    }
  }
  const x0 = Math.round(left + (right - left) * from);
  const x1 = Math.round(left + (right - left) * to);
  let ink = 0;
  let all = 0;
  for (let y = 380; y < 700; y++) {
    for (let x = x0; x < x1; x++) {
      if (solid[(y * 1080 + x) * 4 + 3] < 128) {
        continue;
      }
      all++;
      if (data[(y * 1080 + x) * 4 + 3] > 128) {
        ink++;
      }
    }
  }
  return ink / Math.max(1, all);
}

describe("the stipple texture", () => {
  test("the tile sprays thin at the left edge and runs nearly solid past the middle", () => {
    const share = (x0: number, x1: number) => {
      let on = 0;
      for (let y = 0; y < 80; y++) {
        for (let x = x0; x < x1; x++) {
          on += stippleKeeps(x, y) ? 1 : 0;
        }
      }
      return on / ((x1 - x0) * 80);
    };
    expect(share(0, 6)).toBeLessThan(0.35);
    expect(share(48, 64)).toBeGreaterThan(0.9);
  });

  test("the canvas painter cuts it out of each letter: specks at the left, solid at the right", async () => {
    const o = title({ texture: "stipple" });
    expect(await inkShare(o, 0, 0.2)).toBeLessThan(0.6);
    expect(await inkShare(o, 0.75, 1)).toBeGreaterThan(0.85);
  });

  test("a plate stays whole behind the textured letters", async () => {
    const c = await renderElementCanvas(title({ texture: "stipple", plate: true, plateColor: "#ff0000", plateOpacity: 1 }), 1080, 1080, env);
    const solid = await renderElementCanvas(title({ plate: true, plateColor: "#ff0000", plateOpacity: 1 }), 1080, 1080, env);
    const ctx = c.getContext("2d")!;
    // Every pixel the plate covers stays opaque: the grain shows the plate
    // through the letter, never a hole.
    const a = ctx.getImageData(0, 0, 1080, 1080).data;
    const b = solid.getContext("2d")!.getImageData(0, 0, 1080, 1080).data;
    let holes = 0;
    for (let i = 3; i < a.length; i += 4) {
      if (b[i] > 250 && a[i] < 250) {
        holes++;
      }
    }
    expect(holes).toBe(0);
  });
});

/** Opaque pixels in a rendered element. */
async function inked(o: TextOverlay, phase?: { erode: number }): Promise<number> {
  const c = await renderElementCanvas(o, 540, 540, env, phase);
  const data = c.getContext("2d")!.getImageData(0, 0, 540, 540).data;
  let n = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 128) {
      n++;
    }
  }
  return n;
}

describe("the disintegrate exit", () => {
  const o = title({ text: "MW", size: 300, anim: { out: { style: "disintegrate", seconds: 0.5 } } });

  test("the evaluator eats more of the ink as the exit runs", () => {
    const early = evalOverlayFrame(o, 1.55).erode!;
    const late = evalOverlayFrame(o, 1.9).erode!;
    expect(early).toBeGreaterThanOrEqual(0);
    expect(late).toBeGreaterThan(early);
    expect(evalOverlayFrame(o, 1).erode).toBeUndefined();
  });

  test("the export bakes one picture per frame along the same curve", () => {
    const slices = planAnimatedLayers(o, 10).filter((l) => l.phase?.erode !== undefined);
    expect(slices.length).toBe(15);
    expect(slices[0].phase!.erode!).toBeLessThan(slices[14].phase!.erode!);
  });

  test("the canvas cuts the eaten share out of the ink", async () => {
    const whole = await inked(o);
    const half = await inked(o, { erode: 0.5 });
    expect(half / whole).toBeGreaterThan(0.3);
    expect(half / whole).toBeLessThan(0.7);
    expect(await inked(o, { erode: 1 })).toBe(0);
  });
});
