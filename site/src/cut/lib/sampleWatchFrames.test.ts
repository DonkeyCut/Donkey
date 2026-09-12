import { afterEach, expect, spyOn, test } from "bun:test";
import type { Input, InputVideoTrack, WrappedCanvas } from "mediabunny";
import { sampleWatchFrames } from "./media";
import * as mediaRead from "./mediaRead";
import * as raster from "./raster";

const restores: (() => void)[] = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });

function fixture(failPixels = false) {
  let closed = 0;
  let disposed = false;
  const context = {
    drawImage() {},
    getImageData(_x: number, _y: number, width: number, height: number) {
      if (failPixels) throw new Error("Frame read failed");
      return { data: new Uint8ClampedArray(width * height * 4) };
    },
  };
  const canvas = { getContext: () => context } as unknown as raster.RasterSurface;
  const frame = { canvas, timestamp: 0, duration: 0.5 } as WrappedCanvas;
  const input = { dispose() { disposed = true; } } as unknown as Input;
  const track = { getDisplayWidth: async () => 320, getDisplayHeight: async () => 180 } as unknown as InputVideoTrack;
  const spies = [
    spyOn(mediaRead, "openMedia").mockReturnValue(input),
    spyOn(mediaRead, "videoTrackOf").mockResolvedValue(track),
    spyOn(raster, "createRasterCanvas").mockReturnValue(canvas),
    spyOn(mediaRead, "frameSink").mockReturnValue({
      getCanvas: async () => frame,
      async *canvases() { yield frame; },
      async *canvasesAtTimestamps(times) {
        try { for await (const time of times) yield { ...frame, timestamp: time }; }
        finally { closed++; }
      },
    }),
  ];
  restores.push(...spies.map((spy) => () => spy.mockRestore()));
  return { closed: () => closed, disposed: () => disposed };
}

test("pausing a scene scan closes its decoded-frame iterator", async () => {
  const run = fixture();
  let checks = 0;
  const result = await sampleWatchFrames("fixture.mp4", {
    from: 0, to: 5, interval: 0.5, metadataOnly: true, shouldPause: () => ++checks > 1,
  });
  expect(result.truncated).toBe(true);
  expect(result.candidates).toBe(1);
  expect(run.closed()).toBe(1);
  expect(run.disposed()).toBe(true);
});

test("a failed frame read closes the iterator and its input", async () => {
  const run = fixture(true);
  await expect(sampleWatchFrames("fixture.mp4", { from: 0, to: 5, metadataOnly: true })).rejects.toThrow("Frame read failed");
  expect(run.closed()).toBe(1);
  expect(run.disposed()).toBe(true);
});
