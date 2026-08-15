// The one seam every rasterization surface goes through: canvases the export
// path draws overlays on, and the images it decodes to draw them. The page
// uses the DOM implementations below; a headless process installs a server
// canvas (skia) at startup, and the same drawing code renders the same PNGs.

export type RasterSurface = HTMLCanvasElement | OffscreenCanvas;

export interface RasterImage {
  source: CanvasImageSource;
  width: number;
  height: number;
}

export interface RasterFactory {
  createCanvas(w: number, h: number): RasterSurface;
  /** Decode one image blob; null when the bytes are undecodable. */
  decodeImage(blob: Blob): Promise<RasterImage | null>;
  canvasToPngBlob(canvas: RasterSurface): Promise<Blob>;
}

const domFactory: RasterFactory = {
  createCanvas: (w, h) => {
    if (typeof document === "undefined") return new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
    const c = document.createElement("canvas");
    c.width = Math.max(1, w);
    c.height = Math.max(1, h);
    return c;
  },
  decodeImage: (blob) =>
    new Promise((resolve) => {
      const objectUrl = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        // An SVG with no intrinsic size reports 0×0; treat it as square.
        resolve({ source: img, width: img.naturalWidth || 512, height: img.naturalHeight || 512 });
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(null);
      };
      img.src = objectUrl;
    }),
  canvasToPngBlob: (canvas) => {
    if (typeof OffscreenCanvas !== "undefined" && canvas instanceof OffscreenCanvas)
      return canvas.convertToBlob({ type: "image/png" });
    return new Promise((resolve, reject) =>
      (canvas as HTMLCanvasElement).toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Could not render the image."))),
        "image/png"
      )
    );
  },
};

let factory: RasterFactory = domFactory;

/** Install a replacement surface, e.g. the skia factory in a headless
 * process. Affects every later createRasterCanvas/decodeRasterImage call. */
export function setRasterFactory(f: RasterFactory): void {
  factory = f;
}

export const createRasterCanvas = (w: number, h: number): RasterSurface => factory.createCanvas(w, h);
export const decodeRasterImage = (blob: Blob): Promise<RasterImage | null> => factory.decodeImage(blob);
export const rasterCanvasToPng = (canvas: RasterSurface): Promise<Blob> => factory.canvasToPngBlob(canvas);
