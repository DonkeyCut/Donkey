import { beforeAll, describe, expect, test } from "bun:test";
import { FrameCompositor, type Frame } from "./composite";
import { cameraCardLayout, newCard } from "./cameraCard";
import { setRasterFactory, type RasterSurface } from "./raster";
import type { VideoClip } from "./types";

// The compositor's camera-card pass, drawn onto canvases that record their
// calls: where the picture lands, that the head reads the person matte only
// when the layout shows it, and that the matte multiplies through the same
// placement as the picture.

type Call = { op: string; target: string; args: unknown[]; mode: string };

const calls: Call[] = [];

class RecordingCanvas {
  constructor(
    public width: number,
    public height: number,
    readonly name: string
  ) {}
  private ctx = new Proxy(
    { globalCompositeOperation: "source-over", globalAlpha: 1, filter: "none" } as Record<string, unknown>,
    {
      get: (target, prop) => {
        if (prop in target) return target[prop as string];
        if (prop === "canvas") return this;
        if (prop === "createLinearGradient") return () => ({ addColorStop: () => {} });
        if (typeof prop !== "string") return undefined;
        return (...args: unknown[]) => {
          calls.push({ op: prop, target: this.name, args, mode: String(target.globalCompositeOperation) });
        };
      },
      set: (target, prop, value) => ((target[prop as string] = value), true),
    }
  );
  getContext() {
    return this.ctx;
  }
}

let made = 0;
beforeAll(() => {
  setRasterFactory({
    createCanvas: (w, h) => new RecordingCanvas(w, h, `scratch${made++}`) as unknown as RasterSurface,
    decodeImage: async () => null,
    canvasToBlob: async () => new Blob(),
    snapshot: async (canvas) => canvas as unknown as ImageBitmap,
  });
});

const W = 1080;
const H = 1920;
const picture = { name: "picture" } as unknown as CanvasImageSource;
const matteImage = { name: "matte" } as unknown as CanvasImageSource;
const frame: Frame = { kind: "ready", image: picture, width: 1920, height: 1080 };

const clipOf = (over: Partial<VideoClip> = {}): VideoClip => ({
  id: "speaker",
  assetId: "a1",
  track: 1,
  start: 0,
  in: 0,
  out: 4,
  muted: false,
  card: newCard(),
  ...over,
});

function draw(clip: VideoClip, matte: CanvasImageSource | null) {
  calls.length = 0;
  const comp = new FrameCompositor(new RecordingCanvas(W, H, "frame") as unknown as RasterSurface);
  let asked = 0;
  comp.cardMatteProvider = () => {
    asked++;
    return matte;
  };
  comp.drawLayer(frame, clip, false, 1, 1);
  return { asked };
}

describe("camera card compositing", () => {
  test("the picture lands at the card layout through the card's clip", () => {
    draw(clipOf({ card: { ...newCard(), popOut: false } }), null);
    const L = cameraCardLayout(newCard(), { x: 0, y: 0, w: W, h: H }, 1920, 1080, 1);
    const pic = calls.find((c) => c.op === "drawImage" && c.target === "frame" && c.args[0] === picture);
    expect(pic?.args.slice(1)).toEqual([L.picture.x, L.picture.y, L.picture.w, L.picture.h]);
    expect(calls.some((c) => c.op === "clip" && c.target === "frame")).toBe(true);
  });

  test("the person matte is read only when the card shows the head", () => {
    expect(draw(clipOf({ card: { ...newCard(), popOut: false } }), matteImage).asked).toBe(0);
    expect(draw(clipOf(), matteImage).asked).toBe(1);
  });

  test("the head multiplies the matte through the picture's own placement", () => {
    draw(clipOf(), matteImage);
    const L = cameraCardLayout(newCard(), { x: 0, y: 0, w: W, h: H }, 1920, 1080, 1);
    const keyed = calls.find((c) => c.op === "drawImage" && c.args[0] === matteImage);
    expect(keyed?.mode).toBe("destination-in");
    expect(keyed?.args.slice(1)).toEqual([L.picture.x, L.picture.y, L.picture.w, L.picture.h]);
    // The head lands on the frame after the card's picture.
    const onFrame = calls.filter((c) => c.op === "drawImage" && c.target === "frame");
    expect(onFrame[0].args[0]).toBe(picture);
    expect(onFrame.length).toBe(2);
  });

  test("a side card in a landscape frame keeps the head over the card's columns", () => {
    calls.length = 0;
    const comp = new FrameCompositor(new RecordingCanvas(1920, 1080, "wide") as unknown as RasterSurface);
    comp.cardMatteProvider = () => matteImage;
    comp.drawLayer(frame, clipOf(), false, 1, 1);
    const L = cameraCardLayout(newCard(), { x: 0, y: 0, w: 1920, h: 1080 }, 1920, 1080, 1);
    expect(L.side).toBe("right");
    const pic = calls.find((c) => c.op === "drawImage" && c.target === "wide" && c.args[0] === picture);
    expect(pic?.args.slice(1)).toEqual([L.picture.x, L.picture.y, L.picture.w, L.picture.h]);
    const keyed = calls.find((c) => c.op === "drawImage" && c.args[0] === matteImage);
    const band = calls.find((c) => c.op === "rect" && c.target === keyed?.target);
    expect(band?.args[0]).toBe(L.band.left);
    expect(band?.args[2]).toBe(L.band.right - L.band.left);
  });

  test("without a matte yet the card draws alone", () => {
    draw(clipOf(), null);
    const onFrame = calls.filter((c) => c.op === "drawImage" && c.target === "frame");
    expect(onFrame.length).toBe(1);
  });
});
