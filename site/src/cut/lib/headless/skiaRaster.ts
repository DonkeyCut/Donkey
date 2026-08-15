import { setRasterFactory, type RasterImage, type RasterSurface } from "../raster";

// The server canvas: skia-canvas standing in for the DOM surfaces behind the
// raster seam. Installed once at a headless process's startup; the drawing
// code in composite/textRender/exportClient then renders overlay PNGs the
// same way the page does. The import is dynamic so the page bundle and any
// process without the native module stay unaffected.

export async function installSkiaRaster(): Promise<boolean> {
  try {
    const skia = await import("skia-canvas");
    setRasterFactory({
      createCanvas: (w, h) =>
        new skia.Canvas(Math.max(1, w), Math.max(1, h)) as unknown as RasterSurface,
      decodeImage: async (blob) => {
        try {
          const img = await skia.loadImage(Buffer.from(await blob.arrayBuffer()));
          return {
            source: img as unknown as CanvasImageSource,
            width: img.width || 512,
            height: img.height || 512,
          } satisfies RasterImage;
        } catch {
          return null;
        }
      },
      canvasToPngBlob: async (canvas) => {
        const buf = await (canvas as unknown as InstanceType<typeof skia.Canvas>).toBuffer("png");
        return new Blob([new Uint8Array(buf)], { type: "image/png" });
      },
    });
    return true;
  } catch {
    return false;
  }
}
