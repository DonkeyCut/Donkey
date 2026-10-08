import { afterAll, describe, expect, test } from "bun:test";
import { createRasterCanvas, setRasterFactory, snapshotRaster, type RasterFactory, type RasterSurface } from "./raster";

/** Bitmaps of painted surfaces come from the installed factory, so a headless
 * process that swaps the factory serves every snapshot. */

describe("raster snapshots", () => {
  const seen: RasterSurface[] = [];
  const fake = { close: () => {} } as unknown as ImageBitmap;
  const surface = {} as RasterSurface;
  const factory: RasterFactory = {
    createCanvas: () => surface,
    decodeImage: async () => null,
    canvasToBlob: async () => new Blob(),
    snapshot: async (canvas) => {
      seen.push(canvas);
      return fake;
    },
  };
  let replaced: RasterFactory | undefined;
  afterAll(() => {
    if (replaced) {
      setRasterFactory(replaced);
    }
  });

  test("snapshotRaster goes through the installed factory", async () => {
    replaced = setRasterFactory(factory);
    const canvas = createRasterCanvas(4, 4);
    expect(await snapshotRaster(canvas)).toBe(fake);
    expect(seen).toEqual([surface]);
  });
});
