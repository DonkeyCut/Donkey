import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as kit from "@donkeycut/effects-kit";
import { applyDetail, applyLutToImageData, buildClipLut } from "@donkeycut/effects-kit";
import { FrameCompositor, type Frame } from "./composite";
import { beginLutDraft, clearClipLuts, clipLutKey, endLutDraft, peekClipLut, requestClipLut } from "./lutBuild";
import { setRasterFactory, type RasterSurface } from "./raster";
import type { VideoClip } from "./types";

// The compositor's color path, drawn onto a pixel canvas that stands in for
// the DOM's: what a clip's pixels are after its source conversion, its grade
// and its detail pass — the same numbers the kit's reference passes produce,
// which is what ties the preview to the export.

/** A canvas of bytes: same-size draws copy pixels source-over, reads and
 * writes go straight to the buffer, and everything else is accepted and
 * ignored. No WebGL, so the GPU passes step aside for the CPU ones. */
class PixelCanvas {
  data: Uint8ClampedArray;
  private w: number;
  private h: number;
  readonly ctx: Record<string, unknown>;
  constructor(w: number, h: number) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.data = new Uint8ClampedArray(this.w * this.h * 4);
    this.ctx = new Proxy(
      {
        canvas: this,
        filter: "none",
        globalAlpha: 1,
        globalCompositeOperation: "source-over",
        fillStyle: "#000000",
        imageSmoothingEnabled: true,
        clearRect: () => this.data.fill(0),
        fillRect: () => {
          const hex = /^#?([0-9a-f]{6})$/i.exec(String(this.ctx.fillStyle))?.[1] ?? "000000";
          const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
          for (let i = 0; i < this.data.length; i += 4) {
            this.data[i] = r;
            this.data[i + 1] = g;
            this.data[i + 2] = b;
            this.data[i + 3] = 255;
          }
        },
        drawImage: (src: PixelCanvas, ...args: number[]) => {
          const [dx, dy, dw, dh] =
            args.length >= 8 ? args.slice(4) : args.length >= 4 ? args : [args[0], args[1], src.w, src.h];
          for (let y = 0; y < this.h; y++) {
            for (let x = 0; x < this.w; x++) {
              const sx = Math.floor(((x - dx) / dw) * src.w);
              const sy = Math.floor(((y - dy) / dh) * src.h);
              if (sx < 0 || sy < 0 || sx >= src.w || sy >= src.h) continue;
              const si = (sy * src.w + sx) * 4;
              const di = (y * this.w + x) * 4;
              const a = src.data[si + 3] / 255;
              for (let c = 0; c < 3; c++) this.data[di + c] = Math.round(src.data[si + c] * a + this.data[di + c] * (1 - a));
              this.data[di + 3] = Math.round(255 * (a + (this.data[di + 3] / 255) * (1 - a)));
            }
          }
        },
        getImageData: (x: number, y: number, w: number, h: number) => ({
          data: this.data.slice(0),
          width: w,
          height: h,
        }),
        putImageData: (img: { data: Uint8ClampedArray }) => this.data.set(img.data),
      } as Record<string, unknown>,
      {
        get: (target, prop) =>
          prop in target ? target[prop as string] : typeof prop === "string" ? () => undefined : undefined,
        set: (target, prop, value) => ((target[prop as string] = value), true),
      }
    );
  }
  get width() {
    return this.w;
  }
  set width(v: number) {
    this.w = Math.max(1, v);
    this.data = new Uint8ClampedArray(this.w * this.h * 4);
  }
  get height() {
    return this.h;
  }
  set height(v: number) {
    this.h = Math.max(1, v);
    this.data = new Uint8ClampedArray(this.w * this.h * 4);
  }
  getContext(kind: string) {
    return kind === "2d" ? this.ctx : null;
  }
}

setRasterFactory({
  createCanvas: (w, h) => new PixelCanvas(w, h) as unknown as RasterSurface,
  decodeImage: async () => null,
  canvasToBlob: async () => new Blob(),
});
afterAll(() => clearClipLuts());

const W = 8;
const H = 8;

/** A picture that walks the cube: red across, green down, blue held. */
function picture(): PixelCanvas {
  const c = new PixelCanvas(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      c.data[i] = x * 32;
      c.data[i + 1] = y * 32;
      c.data[i + 2] = 128;
      c.data[i + 3] = 255;
    }
  }
  return c;
}

const frameOf = (c: PixelCanvas): Frame => ({ kind: "ready", image: c as unknown as CanvasImageSource, width: W, height: H });

const clipOf = (over: Partial<VideoClip> = {}): VideoClip => ({
  id: "c1",
  assetId: "a1",
  track: 0,
  start: 0,
  in: 0,
  out: 4,
  muted: false,
  ...over,
});

let canvas: PixelCanvas;
let comp: FrameCompositor;

beforeEach(() => {
  clearClipLuts();
  canvas = new PixelCanvas(W, H);
  comp = new FrameCompositor(canvas as unknown as RasterSurface);
  comp.colorMode = "exact";
});

const drawn = () => Array.from(canvas.data);
const rgb = (px: ArrayLike<number>) => Array.from(px).filter((_, i) => i % 4 !== 3);

describe("the compositor's color path", () => {
  test("a Rec.709 clip with no grade draws its pixels as they are", () => {
    const src = picture();
    comp.drawLayer(frameOf(src), clipOf(), true, 1, 0);
    expect(drawn()).toEqual(Array.from(src.data));
    expect(requestClipLut(comp.recipeFor(clipOf()))).toBeNull();
  });

  test("a log source draws through its conversion LUT, graded or not", () => {
    comp.sourceProvider = () => ({ profile: "apple-log" });
    const src = picture();
    comp.drawLayer(frameOf(src), clipOf(), true, 1, 0);
    const expected = picture().data;
    applyLutToImageData(expected, buildClipLut({ profile: "apple-log", output: "sdr", size: 65 })!);
    expect(rgb(drawn())).toEqual(rgb(expected));
    expect(rgb(drawn())).not.toEqual(rgb(src.data));
  });

  test("a grade bakes into the LUT the export writes, and the pixels match it", () => {
    const grade = { exposure: 10, contrast: 8, saturation: -10 };
    comp.drawLayer(frameOf(picture()), clipOf({ grade }), true, 1, 0);
    const expected = picture().data;
    applyLutToImageData(expected, buildClipLut({ profile: "rec709", grade, output: "sdr", size: 33 })!);
    expect(rgb(drawn())).toEqual(rgb(expected));
  });

  test("sharpen and clarity run after the LUT as the detail pass", () => {
    const grade = { exposure: 10, sharpen: 30, clarity: 20 };
    comp.drawLayer(frameOf(picture()), clipOf({ grade }), true, 1, 0);
    const expected = picture().data;
    applyLutToImageData(expected, buildClipLut({ profile: "rec709", grade: { exposure: 10 }, output: "sdr", size: 33 })!);
    applyDetail(expected, W, H, { sharpen: 30, clarity: 20 });
    expect(rgb(drawn())).toEqual(rgb(expected));
  });

  test("a library LUT that is not on the shelf renders the grade without it, keyed apart", () => {
    const grade = { exposure: 10, lut: { id: "lut:nothere" } };
    comp.drawLayer(frameOf(picture()), clipOf({ grade }), true, 1, 0);
    const expected = picture().data;
    applyLutToImageData(expected, buildClipLut({ profile: "rec709", grade: { exposure: 10 }, output: "sdr", size: 33 })!);
    expect(rgb(drawn())).toEqual(rgb(expected));
    const recipe = comp.recipeFor(clipOf({ grade }));
    expect(clipLutKey(recipe, "lut:nothere", false).endsWith("|lut:nothere:off")).toBe(true);
    expect(clipLutKey(recipe, "lut:nothere", true).endsWith("|lut:nothere:on")).toBe(true);
  });

  test("an HLG composite maps every recipe into HLG, the frame color with it", () => {
    comp.output = "hlg";
    expect(comp.recipeFor(clipOf()).output).toBe("hlg");
    comp.sourceProvider = () => ({ profile: "apple-log" });
    expect(comp.recipeFor(clipOf()).output).toBe("hlg");
    comp.sourceProvider = () => ({ profile: "rec709" });
    // A Rec.709 clip is a conversion now: its pixels land at HLG code values,
    // white at reference white.
    const src = picture();
    comp.drawLayer(frameOf(src), clipOf(), true, 1, 0);
    const expected = picture().data;
    applyLutToImageData(expected, buildClipLut({ profile: "rec709", output: "hlg", size: 33 })!);
    expect(rgb(drawn())).toEqual(rgb(expected));
    expect(rgb(drawn())).not.toEqual(rgb(src.data));
    comp.background = "#ffffff";
    comp.clear();
    expect(Array.from(canvas.data.slice(0, 3))).toEqual([191, 191, 191]);
    comp.output = "sdr";
    expect(comp.recipeFor(clipOf()).output).toBe("sdr");
    comp.clear();
    expect(Array.from(canvas.data.slice(0, 3))).toEqual([255, 255, 255]);
  });

  test("a live drag sizes the cube down and the settle brings the full one back", () => {
    const log = clipOf({ id: "log", assetId: "log" });
    comp.colorMode = "live";
    comp.sourceProvider = (c) => ({ profile: c.assetId === "log" ? "apple-log" : "rec709" });
    expect(comp.recipeFor(clipOf()).size).toBe(33);
    expect(comp.recipeFor(log).size).toBe(65);
    beginLutDraft();
    expect(comp.recipeFor(clipOf()).size).toBe(17);
    expect(comp.recipeFor(log).size).toBe(17);
    endLutDraft();
    expect(comp.recipeFor(clipOf()).size).toBe(33);
  });

  test("a render that writes a picture builds the full cube during a drag", () => {
    // An in-tab export, mask or removal bake running while a slider moves in
    // the editor keeps the full cube: the drag's draft is the preview's alone.
    const log = clipOf({ id: "log", assetId: "log" });
    comp.sourceProvider = (c) => ({ profile: c.assetId === "log" ? "apple-log" : "rec709" });
    beginLutDraft();
    try {
      expect(comp.recipeFor(clipOf()).size).toBe(33);
      expect(comp.recipeFor(log).size).toBe(65);
    } finally {
      endLutDraft();
    }
  });

  test("a frame that changes nothing reuses the clip's recipe and key", () => {
    const log = { profile: "apple-log" as const };
    comp.sourceProvider = () => log;
    const grade = { exposure: 10 };
    const clip = clipOf({ grade });
    const keyOf = spyOn(kit, "recipeKey");
    try {
      const recipe = comp.recipeFor(clip);
      const first = requestClipLut(recipe, { exact: true })!;
      const keyed = keyOf.mock.calls.length;
      expect(keyed).toBeGreaterThan(0);
      for (let i = 0; i < 5; i++) {
        const again = comp.recipeFor(clip);
        expect(again).toBe(recipe);
        expect(requestClipLut(again, { exact: true })).toBe(first);
      }
      expect(keyOf.mock.calls.length).toBe(keyed);
      // A new grade, a new source or a new output is a new recipe and key.
      const regraded = comp.recipeFor(clipOf({ grade: { exposure: 20 } }));
      expect(regraded).not.toBe(recipe);
      expect(clipLutKey(regraded, null, false)).not.toBe(first.key);
      comp.sourceProvider = () => ({ profile: "hlg" });
      const resourced = comp.recipeFor(clip);
      expect(resourced).not.toBe(recipe);
      expect(clipLutKey(resourced, null, false)).not.toBe(first.key);
      comp.sourceProvider = () => log;
      comp.output = "hlg";
      expect(comp.recipeFor(clip)).not.toBe(recipe);
      comp.output = "sdr";
      expect(comp.recipeFor(clip)).toBe(recipe);
    } finally {
      keyOf.mockRestore();
    }
  });

  test("a built LUT is kept and answered from the cache", () => {
    const recipe = comp.recipeFor(clipOf({ grade: { exposure: 10 } }));
    const first = requestClipLut(recipe, { exact: true })!;
    expect(first.lut.size).toBe(33);
    expect(peekClipLut(first.key)?.lut).toBe(first.lut);
    expect(requestClipLut(recipe, { exact: true })!.lut).toBe(first.lut);
    clearClipLuts();
    expect(peekClipLut(first.key)).toBeUndefined();
  });
});
