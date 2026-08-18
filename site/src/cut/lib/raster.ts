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
  /** Encode a canvas. `type` is a MIME type ("image/png", "image/jpeg");
   * `quality` applies to the lossy ones. */
  canvasToBlob(canvas: RasterSurface, type: string, quality?: number): Promise<Blob>;
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
  canvasToBlob: (canvas, type, quality) => {
    if (typeof OffscreenCanvas !== "undefined" && canvas instanceof OffscreenCanvas)
      return canvas.convertToBlob({ type, ...(quality !== undefined ? { quality } : {}) });
    return new Promise((resolve, reject) =>
      (canvas as HTMLCanvasElement).toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Could not render the image."))),
        type,
        quality
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
export const rasterCanvasToPng = (canvas: RasterSurface): Promise<Blob> =>
  factory.canvasToBlob(canvas, "image/png");
export const rasterCanvasToBlob = (
  canvas: RasterSurface,
  type: string,
  quality?: number
): Promise<Blob> => factory.canvasToBlob(canvas, type, quality);

/** Decode an image that lives at a URL. Goes through `fetch` so the same call
 * works on a page and in a process with no `Image` constructor; anonymous CORS
 * is what the DOM decoders use, so a cross-origin read shares their cache
 * entry and never taints what it draws into. */
export async function decodeRasterImageUrl(url: string): Promise<RasterImage | null> {
  try {
    const res = await fetch(url, { mode: "cors" });
    if (res.ok) return await factory.decodeImage(await res.blob());
  } catch {
    // A host that sends no CORS header refuses the fetch; the page can still
    // see the picture through an element load.
  }
  return elementImage(url);
}

/** An `<img>` read of a URL the fetch above could not have — a host that
 * serves pictures with no CORS header still answers one. Enough to measure a
 * picture with; drawing it taints the canvas, so an encode of it fails the way
 * the refused fetch would have. */
function elementImage(url: string): Promise<RasterImage | null> {
  if (typeof document === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    // The intrinsic size as reported: 0 is how a caller learns it is unknown.
    img.onload = () => resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** A canvas as a data: URL. Encoding rides the same seam as the blob path, so
 * the string a headless render produces is byte-for-byte the page's. */
export async function rasterCanvasToDataUrl(
  canvas: RasterSurface,
  type: string,
  quality?: number
): Promise<string> {
  const blob = await factory.canvasToBlob(canvas, type, quality);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Chunked so a multi-megabyte sheet doesn't blow the argument limit.
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(binary)}`;
}
