import { beforeAll, expect, test } from "bun:test";
import { installSkiaRaster } from "./headless/skiaRaster";
import { renderProjectFrame } from "./exportRender";
import { decodeRasterImage } from "./raster";
import { renderElementFrames } from "./textRender";
import type { ExportDoc } from "./renderSnapshot";
import type { TextOverlay } from "./types";

const size = { width: 320, height: 180 };
const color = "#c9a227";
const corners = [[1, 1], [size.width - 2, 1], [1, size.height - 2], [size.width - 2, size.height - 2]];

beforeAll(async () => {
  expect(await installSkiaRaster()).toBe(true);
});

// A transformed title must still land its ink at all four frame corners.
for (const pose of [
  { x: 0.5, y: 0.5, scale: 0.5, rotation: 0 },
  { x: 0.3, y: 0.7, scale: 0.5, rotation: 30 },
  { x: 0.7, y: 0.3, scale: 2, rotation: -30 },
]) {
  test(`dive fills the frame at scale ${pose.scale} and rotation ${pose.rotation}`, async () => {
    const title: TextOverlay = {
      id: "title", text: "THE END", start: 0, end: 4.25,
      x: 0.5, y: 0.5, size: 320, font: "sf", weight: 700,
      color, plate: false, shadow: false,
      kf: [{ t: 0, ...pose, opacity: 1 }],
      anim: { in: { style: "slot", seconds: 2 }, out: { style: "dive", seconds: 0.75 } },
    };
    const doc: ExportDoc = {
      aspect: "16:9", assets: [], clips: [], audioClips: [], overlays: [title],
      subtitles: { cues: [], showOnVideo: false, showOnTimeline: false },
    };
    const canvas = await renderProjectFrame(doc, title.end - 0.001, size, () => "");
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;

    try {
      for (const [x, y] of corners) {
        expect([...ctx.getImageData(x, y, 1, 1).data]).toEqual([201, 162, 39, 255]);
      }
    } finally {
      canvas.width = 1;
      canvas.height = 1;
    }

    // The engine's sampled PNG sequence must land on the same full frame.
    const frames = await renderElementFrames(title, size.width, size.height, 30);
    expect([frames.x, frames.y, frames.w, frames.h]).toEqual([0, 0, size.width, size.height]);
    const image = await decodeRasterImage(frames.images.at(-1)!);
    expect(image).not.toBeNull();
    canvas.width = size.width;
    canvas.height = size.height;

    try {
      ctx.drawImage(image!.source, 0, 0);
      for (const [x, y] of corners) {
        expect([...ctx.getImageData(x, y, 1, 1).data]).toEqual([201, 162, 39, 255]);
      }
    } finally {
      canvas.width = 1;
      canvas.height = 1;
    }
  });
}
