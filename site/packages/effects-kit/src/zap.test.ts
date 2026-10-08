import { describe, expect, test } from "bun:test";
import { Canvas } from "skia-canvas";
import { evalOverlayFrame } from "./keys";
import { planAnimatedLayers, renderElementCanvas, type RenderEnv } from "./render";
import type { TextOverlay } from "./types";
import { zapSeed } from "./zap";

const env: RenderEnv = {
  fontStack: () => "Arial",
  createCanvas: (w, h) => new Canvas(w, h) as unknown as HTMLCanvasElement,
  canvasToPngBlob: async (c) => new Blob([new Uint8Array(await (c as unknown as Canvas).toBuffer("png"))]),
};

// A title that crackles from 0.3s for a second.
const title: TextOverlay = {
  id: "t",
  text: "SOON",
  start: 2,
  end: 4.5,
  x: 0.5,
  y: 0.5,
  size: 200,
  font: "sf",
  weight: 700,
  color: "#ffffff",
  shadow: false,
  plate: false,
  anim: { hit: { style: "zap", at: 0.3, seconds: 1 } },
};

/** Pixels bluer than they are red: the arcs' glow, never the white type. */
function blue(c: HTMLCanvasElement): number {
  const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 40 && d[i + 2] > d[i] + 30) {
      n++;
    }
  }
  return n;
}

describe("the zap hit", () => {
  test("it crackles only inside the hit's window", () => {
    expect(evalOverlayFrame(title, 0.1).zap).toBeUndefined();
    expect(evalOverlayFrame(title, 0.8).zap).toBeCloseTo(1);
    expect(evalOverlayFrame(title, 1.5).zap).toBeUndefined();
  });

  test("the export bakes the hit frame by frame, each a fresh deal of the arcs", () => {
    const zaps = planAnimatedLayers(title, 10).filter((l) => l.phase?.zap);
    expect(zaps.length).toBeGreaterThanOrEqual(28);
    expect(new Set(zaps.map((l) => l.phase!.zap!.seed)).size).toBeGreaterThan(8);
    expect(zaps[0].start).toBeCloseTo(2.3);
  });

  test("the painter lays blue arcs over the element, and the same deal twice alike", async () => {
    const calm = await renderElementCanvas(title, 540, 540, env);
    const zap = { amount: 1, seed: zapSeed(0.8) };
    const a = await renderElementCanvas(title, 540, 540, env, { zap });
    const b = await renderElementCanvas(title, 540, 540, env, { zap });
    expect(blue(calm)).toBe(0);
    expect(blue(a)).toBeGreaterThan(200);
    expect(blue(b)).toBe(blue(a));
  });
});

/** The centroid of the arcs' blue glow, in frame fractions. */
function blueCenter(c: HTMLCanvasElement): { x: number; y: number } {
  const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 40 && d[i + 2] > d[i] + 30) {
      const p = i / 4;
      sx += p % c.width;
      sy += Math.floor(p / c.width);
      n++;
    }
  }
  return { x: sx / n / c.width, y: sy / n / c.height };
}

describe("the zap over a textured title", () => {
  test("the arcs crackle over the letters wherever the title sits", async () => {
    const o: TextOverlay = { ...title, texture: "stipple", x: 0.5, y: 0.55 };
    // Averaged over deals, the arcs center on the letters: a dealer that
    // leans one way drags every deal off to that side.
    let x = 0;
    let y = 0;
    const seeds = [1, 3, 5, 8, 11, 19, 27, 40];
    for (const seed of seeds) {
      const at = blueCenter(await renderElementCanvas(o, 1080, 1920, env, { zap: { amount: 1, seed } }));
      x += at.x / seeds.length;
      y += at.y / seeds.length;
    }
    expect(Math.abs(x - 0.5)).toBeLessThan(0.06);
    expect(Math.abs(y - 0.55)).toBeLessThan(0.02);
  });
});

describe("a zap over the entrance", () => {
  test("the export bakes arcs from the hit's start, inside the ramp too", () => {
    // The hit lands 0.17s in, while a 0.45s fade is still bringing it up.
    const o: TextOverlay = { ...title, anim: { in: { style: "fade", seconds: 0.45 }, hit: { style: "zap", at: 0.17, seconds: 0.75 } } };
    const layers = planAnimatedLayers(o, 10);
    const zaps = layers.filter((l) => l.phase?.zap);
    expect(zaps[0].start).toBeCloseTo(2.17 + 1 / 30, 1);
    // The ramp's own motion still rides the pieces: they keep the fade.
    expect(zaps.some((l) => l.start < 2.45 && l.anim.in)).toBe(true);
    // The windows still tile the element without gaps or overlaps.
    const sorted = [...layers].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].start).toBeCloseTo(sorted[i - 1].end, 6);
    }
  });
});
