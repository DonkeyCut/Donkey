import { describe, expect, test } from "bun:test";
import { Canvas } from "skia-canvas";
import { paintPattern, stripeGeometry, stripesSolid } from "./pattern";
import { measureElementBounds, renderElementCanvas, type RenderEnv } from "./render";
import type { ShapeOverlay } from "./types";

const env: RenderEnv = {
  fontStack: () => "Arial",
  createCanvas: (w, h) => new Canvas(w, h) as unknown as HTMLCanvasElement,
  canvasToPngBlob: async (c) => new Blob([new Uint8Array(await (c as unknown as Canvas).toBuffer("png"))]),
};

const pixel = (c: HTMLCanvasElement | Canvas, x: number, y: number) =>
  (c.getContext("2d") as unknown as CanvasRenderingContext2D).getImageData(x, y, 1, 1).data;

// Lit columns along row y, as a string of 1s and 0s.
const litRow = (c: Canvas, y: number) =>
  Array.from({ length: c.width }, (_, x) => (pixel(c, x, y)[3] > 127 ? "1" : "0")).join("");

const bar = (extra: Partial<ShapeOverlay>): ShapeOverlay => ({
  id: "s",
  kind: "shape",
  shape: "rect",
  start: 0,
  end: 4,
  x: 0.5,
  y: 0.5,
  w: 0.4,
  h: 0.4,
  fill: "#ffffff",
  ...extra,
});

describe("stripes", () => {
  test("lay 2 px lines with 1 px gaps from the box's left edge", () => {
    const c = new Canvas(30, 4);
    const ctx = c.getContext("2d") as unknown as CanvasRenderingContext2D;
    paintPattern(ctx, { kind: "stripes", width: 2, gap: 1 }, 30, 4, "#ffffff", 1);
    expect(litRow(c, 2)).toBe("110".repeat(10));
  });

  test("scale with the frame: a half-size frame halves line and gap", () => {
    const g = stripeGeometry({ kind: "stripes", width: 4, gap: 2 }, 0.5);
    expect(g).toEqual({ line: 2, period: 3, angle: 0 });
  });

  test("turn about the box center: 90 degrees lays them across", () => {
    const c = new Canvas(12, 12);
    const ctx = c.getContext("2d") as unknown as CanvasRenderingContext2D;
    paintPattern(ctx, { kind: "stripes", width: 2, gap: 1, angle: 90 }, 12, 12, "#ffffff", 1);
    const column = Array.from({ length: 12 }, (_, y) => (pixel(c, 6, y)[3] > 127 ? "1" : "0")).join("");
    expect(column).toBe("110".repeat(4));
    expect(litRow(c, 0)).toBe("1".repeat(12));
  });

  test("one line every period across a loading bar 0.79 of a 1080 frame", () => {
    // 2 px lines + 1 px gaps over 853 px: one line every 3 px.
    const c = new Canvas(1080, 4);
    const ctx = c.getContext("2d") as unknown as CanvasRenderingContext2D;
    paintPattern(ctx, { kind: "stripes", width: 2, gap: 1 }, Math.round(0.79 * 1080), 4, "#ffffff", 1);
    const lines = litRow(c, 2).match(/1+/g) ?? [];
    expect(lines.length).toBe(Math.ceil(853 / 3));
  });

  test("fill solid with no gap", () => {
    expect(stripesSolid(stripeGeometry({ kind: "stripes", width: 2, gap: 0 }, 1))).toBe(true);
    expect(stripesSolid(stripeGeometry({ kind: "stripes", width: 2, gap: 1 }, 1))).toBe(false);
  });
});

describe("a shape's pattern fill", () => {
  test("clips the stripes to the outline", async () => {
    // 216 px frame, scale 0.2: 10/5 design px land as 2 px lines, 1 px gaps
    // over the box 54..162.
    const o = bar({ w: 0.5, h: 0.5, pattern: { kind: "stripes", width: 10, gap: 5 } });
    const c = await renderElementCanvas(o, 216, 216, env);
    expect(pixel(c, 54, 108)[3]).toBe(255);
    expect(pixel(c, 55, 108)[3]).toBe(255);
    expect(pixel(c, 56, 108)[3]).toBe(0);
    expect(pixel(c, 57, 108)[3]).toBe(255);
    expect(pixel(c, 50, 108)[3]).toBe(0);
    expect(pixel(c, 108, 50)[3]).toBe(0);
  });
});

describe("a shape's shadow", () => {
  const glow = { color: "#00ffff", blur: 20, offsetY: 0, opacity: 1 };

  test("glows past the outline in its color and leaves the body as painted", async () => {
    const c = await renderElementCanvas(bar({ shadow: glow }), 200, 200, env);
    const spill = pixel(c, 55, 100);
    expect(spill[3]).toBeGreaterThan(0);
    expect(spill[0]).toBeLessThan(spill[2]);
    expect(Array.from(pixel(c, 100, 100))).toEqual([255, 255, 255, 255]);
    expect(pixel(c, 2, 2)[3]).toBe(0);
  });

  test("follows a turned shape", async () => {
    const c = await renderElementCanvas(bar({ shadow: glow, rotation: 45 }), 200, 200, env);
    // The turned square's top corner sits at y ≈ 43; just above it is glow.
    expect(pixel(c, 100, 40)[3]).toBeGreaterThan(0);
    expect(pixel(c, 100, 100)[3]).toBe(255);
    expect(pixel(c, 2, 2)[3]).toBe(0);
  });

  test("glows around a striped fill and through its gaps", async () => {
    const o = bar({ w: 0.5, h: 0.5, shadow: glow, pattern: { kind: "stripes", width: 10, gap: 5 } });
    const c = await renderElementCanvas(o, 216, 216, env);
    expect(pixel(c, 50, 108)[3]).toBeGreaterThan(0);
    expect(pixel(c, 56, 108)[3]).toBeGreaterThan(0);
  });

  test("pads the crop by its blur and offset", async () => {
    const frame = { width: 1080, height: 1080, scale: 1 };
    const plain = await measureElementBounds(bar({}), frame, env);
    const lit = await measureElementBounds(bar({ shadow: { blur: 20, offsetY: 4 } }), frame, env);
    expect(lit.w - plain.w).toBe(48);
    expect(lit.h - plain.h).toBe(48);
    const tight = await measureElementBounds(bar({ shadow: { blur: 20, offsetY: 4 } }), frame, env, { pad: false });
    expect(tight.w).toBe(plain.w);
  });
});
