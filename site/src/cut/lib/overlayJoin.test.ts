import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Canvas } from "skia-canvas";
import { FrameCompositor, type Frame } from "./composite";
import { setRasterFactory, type RasterFactory, type RasterSurface } from "./raster";
import type { FrameRect, TransitionStyle, VideoClip } from "./types";

/**
 * A join between two upper-track clips, drawn over a green track beneath:
 * the pair plays the style's geometry, and wherever neither clip covers the
 * frame the track beneath shows.
 */

const W = 160;
const H = 90;

// The suite shares one raster seam, so the skia factory comes out after this
// file: left in, later files measure and draw with it.
let restore: RasterFactory | undefined;
beforeAll(() => {
  restore = setRasterFactory({
    createCanvas: (w, h) => new Canvas(w, h) as unknown as RasterSurface,
    decodeImage: async () => null,
    canvasToBlob: async () => new Blob(),
    snapshot: async (canvas) => canvas as unknown as ImageBitmap,
  });
});
afterAll(() => {
  if (restore) {
    setRasterFactory(restore);
  }
});

function solid(color: string): Frame {
  const c = new Canvas(W, H);
  const ctx = c.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, W, H);
  return { kind: "ready", image: c as unknown as CanvasImageSource, width: W, height: H };
}

const clipOf = (over: Partial<VideoClip> = {}): VideoClip => ({
  id: "c1",
  assetId: "a1",
  track: 1,
  start: 0,
  in: 0,
  out: 4,
  muted: false,
  transition: 0.5,
  ...over,
});

/** The frame at progress `p` of a red → blue `style` join over green, the
 * incoming clip in `incFrame` when given. Returns an RGB reader. */
function joinFrame(style: TransitionStyle, p: number, incFrame?: FrameRect) {
  const canvas = new Canvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#00ff00";
  ctx.fillRect(0, 0, W, H);
  const comp = new FrameCompositor(canvas as unknown as HTMLCanvasElement);
  comp.drawOverlayJoin(
    style,
    p,
    {
      masterFrame: solid("#ff0000"),
      masterClip: clipOf({ transitionStyle: style }),
      masterAlpha: 1,
      masterZoom: 1,
      masterFx: { dx: 0, dy: 0 },
      incFrame: solid("#0000ff"),
      incClip: clipOf({ id: "c2", start: 4, transition: 0, ...(incFrame ? { frame: incFrame, fit: "fill" } : {}) }),
      incAlpha: p,
      incZoom: 1,
    },
    3.75
  );
  const rgba = ctx.getImageData(0, 0, W, H).data;
  return (x: number, y: number) => {
    const i = (Math.round(y * H) * W + Math.round(x * W)) * 4;
    return [rgba[i], rgba[i + 1], rgba[i + 2]];
  };
}

const RED = [255, 0, 0];
const BLUE = [0, 0, 255];
const GREEN = [0, 255, 0];

describe("an upper-track join", () => {
  test("a wipe mid-window shows the incoming clip behind the edge and the outgoing one past it", () => {
    const px = joinFrame("wiperight", 0.5);
    expect(px(0.25, 0.5)).toEqual(BLUE);
    expect(px(0.75, 0.5)).toEqual(RED);
  });

  test("where the wipe uncovers and the incoming clip does not reach, the track beneath shows", () => {
    const px = joinFrame("wiperight", 0.5, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(px(0.1, 0.5)).toEqual(GREEN);
    expect(px(0.4, 0.5)).toEqual(BLUE);
    expect(px(0.75, 0.5)).toEqual(RED);
  });

  test("a dip darkens the layer's own pixels and leaves the track beneath alone", () => {
    const px = joinFrame("dipblack", 0.5, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(px(0.5, 0.5)).toEqual([0, 0, 0]);
    expect(px(0.1, 0.1)).toEqual(GREEN);
  });

  test("a crossfade fades the outgoing clip out where the incoming one has no picture", () => {
    const px = joinFrame("crossfade", 0.5, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    const [r, g, b] = px(0.1, 0.1);
    expect(Math.abs(r - 128)).toBeLessThan(3);
    expect(Math.abs(g - 128)).toBeLessThan(3);
    expect(b).toBe(0);
    const [r2, , b2] = px(0.5, 0.5);
    expect(Math.abs(r2 - 128)).toBeLessThan(3);
    expect(Math.abs(b2 - 128)).toBeLessThan(3);
  });

  test("a push carries both clips across the frame", () => {
    const px = joinFrame("pushleft", 0.5);
    expect(px(0.25, 0.5)).toEqual(RED);
    expect(px(0.75, 0.5)).toEqual(BLUE);
  });
});
