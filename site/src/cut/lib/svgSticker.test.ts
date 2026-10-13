import { describe, expect, test } from "bun:test";
import { setRasterFactory, type RasterFactory, type RasterSurface } from "./raster";
import { rasterizeSvg, sizedSvg, svgAspect } from "./svgSticker";

describe("drawn stickers", () => {
  test("the aspect comes from the viewBox, else width and height", () => {
    expect(svgAspect('<svg viewBox="0 0 200 100"><rect/></svg>')).toBe(2);
    expect(svgAspect("<svg viewBox='-10 -10 50,100'></svg>")).toBe(0.5);
    expect(svgAspect('<svg width="30" height="60"></svg>')).toBe(0.5);
    expect(svgAspect("<svg><rect/></svg>")).toBeNull();
  });

  test("the root is sized to the raster and carries the SVG namespace once", () => {
    const out = sizedSvg('<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M1 1"/></svg>', 512, 512);
    expect(out.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 24 24" fill="none">')).toBe(true);
    expect(out.match(/xmlns=/g)!.length).toBe(1);
  });

  test("markup that could run code or load files is refused", () => {
    expect(() => sizedSvg('<svg viewBox="0 0 1 1"><script>x</script></svg>', 8, 8)).toThrow();
    expect(() => sizedSvg('<svg viewBox="0 0 1 1" onload="x()"></svg>', 8, 8)).toThrow();
    expect(() => sizedSvg('<svg viewBox="0 0 1 1"><image href="https://x/y.png"/></svg>', 8, 8)).toThrow();
    expect(() => sizedSvg("<div>not svg</div>", 8, 8)).toThrow();
    expect(() => sizedSvg("<svg><rect/></svg>", 8, 8)).toThrow();
    expect(sizedSvg('<svg viewBox="0 0 1 1"><use href="#a"/></svg>', 8, 8)).toContain('href="#a"');
  });
});

describe("drawing a sticker", () => {
  test("rasterizes through the raster seam, so a headless runner draws it too", async () => {
    const drawn: { w: number; h: number; blobType: string }[] = [];
    const fake: RasterFactory = {
      createCanvas: (w, h) => {
        const ctx = { drawImage: () => {} };
        return { width: w, height: h, getContext: () => ctx } as unknown as RasterSurface;
      },
      decodeImage: async (blob) => {
        drawn.push({ w: 0, h: 0, blobType: blob.type });
        return { source: {} as CanvasImageSource, width: 1024, height: 512 };
      },
      canvasToBlob: async (canvas, type) => {
        drawn[drawn.length - 1] = { ...drawn[drawn.length - 1], w: canvas.width, h: canvas.height };
        return new Blob(["png"], { type });
      },
      snapshot: async () => ({}) as ImageBitmap,
    };
    const replaced = setRasterFactory(fake);
    try {
      const png = await rasterizeSvg('<svg viewBox="0 0 200 100"><rect width="200" height="100"/></svg>');
      expect(png.type).toBe("image/png");
      expect(drawn).toEqual([{ w: 1024, h: 512, blobType: "image/svg+xml" }]);
    } finally {
      setRasterFactory(replaced);
    }
  });

  test("markup the decoder cannot read is a clear error", async () => {
    const replaced = setRasterFactory({
      createCanvas: () => ({}) as RasterSurface,
      decodeImage: async () => null,
      canvasToBlob: async () => new Blob(),
      snapshot: async () => ({}) as ImageBitmap,
    });
    try {
      await expect(rasterizeSvg('<svg viewBox="0 0 1 1"><bogus</svg>')).rejects.toThrow("did not draw");
    } finally {
      setRasterFactory(replaced);
    }
  });
});
