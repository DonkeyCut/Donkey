import { setRasterFactory, type RasterImage, type RasterSurface } from "../raster";

// The server canvas: skia-canvas standing in for the DOM surfaces behind the
// raster seam. Installed once at a headless process's startup; the drawing
// code in composite/textRender/exportClient then renders overlay PNGs the
// same way the page does. The import is dynamic so the page bundle and any
// process without the native module stay unaffected.
//
// The skia canvas also lands on `globalThis.OffscreenCanvas`, wrapped so it
// answers `convertToBlob`. Page code branches on that class to tell a worker
// surface from a DOM one, and a headless process is the worker case: with the
// global in place those branches take the path they were written for instead
// of reaching for a `document` that isn't there.

/** skia names its encoders by extension ("png", "jpeg"); the seam speaks MIME. */
const skiaFormat = (type: string) =>
  type.replace(/^image\//, "") as Parameters<
    import("skia-canvas").Canvas["toBuffer"]
  >[0];

/** True once a skia surface backs the seam (a worker without the native
 * module keeps the DOM factory and runs its ffmpeg-only jobs). */
export async function installSkiaRaster(): Promise<boolean> {
  try {
    const skia = await import("skia-canvas");

    class ServerCanvas extends skia.Canvas {
      async convertToBlob(opts?: { type?: string; quality?: number }): Promise<Blob> {
        const type = opts?.type ?? "image/png";
        const buf = await this.toBuffer(skiaFormat(type), {
          ...(opts?.quality !== undefined ? { quality: opts.quality } : {}),
        });
        return new Blob([new Uint8Array(buf)], { type });
      }
    }
    const scope = globalThis as Record<string, unknown>;
    scope.OffscreenCanvas ??= ServerCanvas;
    // The rest of the drawing vocabulary page code expects to find lying
    // around: pixel buffers, an image class, and the decoder every cached
    // stamp and still goes through.
    scope.ImageData ??= skia.ImageData;
    scope.Image ??= skia.Image;
    scope.createImageBitmap ??= async (src: unknown) => {
      const bytes =
        src instanceof Blob
          ? Buffer.from(await src.arrayBuffer())
          : Buffer.from(await (src as InstanceType<typeof skia.Canvas>).toBuffer("png"));
      const img = await skia.loadImage(bytes);
      // ImageBitmap is disposable; skia images are collected. A no-op close
      // keeps every `bitmap.close()` in the drawing code honest.
      return Object.assign(img, { close: () => {} });
    };

    setRasterFactory({
      createCanvas: (w, h) =>
        new ServerCanvas(Math.max(1, w), Math.max(1, h)) as unknown as RasterSurface,
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
      canvasToBlob: async (canvas, type, quality) => {
        const buf = await (canvas as unknown as InstanceType<typeof skia.Canvas>).toBuffer(
          skiaFormat(type),
          { ...(quality !== undefined ? { quality } : {}) }
        );
        return new Blob([new Uint8Array(buf)], { type });
      },
    });
    return true;
  } catch {
    return false;
  }
}
