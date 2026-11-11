import { expect, test } from "bun:test";
import { createRasterCanvas } from "../raster";
import { installSkiaRaster } from "./skiaRaster";

// A headless render draws thousands of overlay stills; GPU-backed canvases
// held their textures as wired memory until collection, and one render
// peaked past 38 GB. Every server canvas draws on the CPU.
test("server canvases draw on the CPU", async () => {
  expect(await installSkiaRaster()).toBe(true);
  const canvas = createRasterCanvas(64, 36) as unknown as { gpu: boolean };
  expect(canvas.gpu).toBe(false);
  const offscreen = new OffscreenCanvas(64, 36) as unknown as { gpu: boolean };
  expect(offscreen.gpu).toBe(false);
});
