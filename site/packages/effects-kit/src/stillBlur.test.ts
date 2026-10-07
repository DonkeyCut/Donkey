import { describe, expect, test } from "bun:test";
import { Canvas } from "skia-canvas";
import { renderStillCanvas, type RenderEnv } from "./render";
import type { ShapeOverlay } from "./types";

const env: RenderEnv = {
  fontStack: () => "Arial",
  createCanvas: (w, h) => new Canvas(w, h) as unknown as HTMLCanvasElement,
  canvasToPngBlob: async (c) => new Blob([new Uint8Array(await (c as unknown as Canvas).toBuffer("png"))]),
};

const box = (blur?: number): ShapeOverlay =>
  ({ id: "s", kind: "shape", shape: "rect", start: 0, end: 4, x: 0.5, y: 0.5, w: 0.4, h: 0.4, fill: "#ffffff", ...(blur ? { blur } : {}) }) as ShapeOverlay;

const alphaAt = (c: HTMLCanvasElement, x: number, y: number) =>
  (c.getContext("2d") as CanvasRenderingContext2D).getImageData(x, y, 1, 1).data[3];

describe("a still element's picture", () => {
  test("bakes its own blur in, softening the edge", async () => {
    const sharp = await renderStillCanvas(box(), 200, 200, env);
    const soft = await renderStillCanvas(box(20), 200, 200, env);
    // The box spans 60..140; just outside its edge the sharp picture is empty
    // and the blurred one has spilled ink there.
    expect(alphaAt(sharp, 55, 100)).toBe(0);
    expect(alphaAt(soft, 55, 100)).toBeGreaterThan(0);
    expect(alphaAt(soft, 100, 100)).toBe(255);
  });
});
