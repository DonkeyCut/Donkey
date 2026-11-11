import { beforeAll, expect, test } from "bun:test";
import type { ShapeOverlay } from "@donkeycut/effects-kit";
import { installSkiaRaster } from "./headless/skiaRaster";
import { buildExportPayload, previewSettings } from "./exportClient";
import { createRasterCanvas, decodeRasterImage } from "./raster";
import type { ExportDoc } from "./renderSnapshot";
import type { MediaAsset, VideoClip } from "./types";

// Everything the export paints per frame samples on the output's own frame
// grid. The ffmpeg graph poses a keyed clip on every output frame, so an
// element or a clip shadow sampled on another grid trails the clip it rides
// with: at the 24 fps draft target a 30 fps element sequence lags its clip
// by up to a 30th of a second, and a fast slide pulls them visibly apart.

beforeAll(async () => {
  expect(await installSkiaRaster()).toBe(true);
});

const FPS = 24;

const settings = { ...previewSettings("16:9"), width: 320, height: 180 };

const slide: ShapeOverlay = {
  id: "s", kind: "shape", shape: "rect", start: 0, end: 1,
  x: 0.5, y: 0.5, w: 0.2, h: 0.2, fill: "#ffffff",
  kf: [
    { t: 0, x: 0.1, y: 0.5, scale: 1, rotation: 0, opacity: 1 },
    { t: 1, x: 0.9, y: 0.5, scale: 1, rotation: 0, opacity: 1 },
  ],
} as ShapeOverlay;

// A boxed print whose shadow fades in over a tenth of a second, on track 0
// and on an upper track that starts between two 24 fps frames.
const print = (id: string, track: number, start: number): VideoClip => ({
  id, assetId: "v", track, start, in: 0, out: 0.4, muted: true, fit: "fill",
  frame: { x: 0.3, y: 0.2, w: 0.4, h: 0.5 },
  boxStyle: { shadow: { blur: 4, y: 4, opacity: 1 } },
  kf: [
    { t: 0, x: 0.3, y: 0.45, scale: 1, rotation: 0, opacity: 0 },
    { t: 0.1, x: 0.7, y: 0.45, scale: 1, rotation: 0, opacity: 1 },
  ],
} as VideoClip);

const doc = (over: Partial<ExportDoc>): ExportDoc => ({
  aspect: "16:9",
  assets: [{
    id: "v", fileName: "v.mp4", name: "V", type: "video", duration: 2, width: 1920, height: 1080, url: "",
    color: { matrix: "bt709", fullRange: false, bitDepth: 8, detected: "rec709" },
  } as MediaAsset],
  clips: [],
  audioClips: [],
  overlays: [],
  subtitles: { cues: [], showOnVideo: false, showOnTimeline: false },
  ...over,
});

/** The strongest alpha anywhere in a painted PNG. */
async function maxAlpha(blob: Blob): Promise<number> {
  const img = await decodeRasterImage(blob);
  const canvas = createRasterCanvas(img!.width, img!.height);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  ctx.drawImage(img!.source, 0, 0);
  const px = ctx.getImageData(0, 0, img!.width, img!.height).data;
  let max = 0;
  for (let i = 3; i < px.length; i += 4) {
    max = Math.max(max, px[i]);
  }
  return max;
}

test("a keyed element samples one picture per 24 fps draft frame", async () => {
  const payload = await buildExportPayload("project", doc({ overlays: [slide] }), settings, "preview");
  const frames = (payload.spec as { overlays: { frames?: { duration: number }[] }[] }).overlays[0].frames!;

  expect(frames.length).toBe(FPS);
  for (const f of frames) {
    expect(f.duration).toBeCloseTo(1 / FPS, 6);
  }
});

test("a keyed clip's shadow samples on the draft's frame grid", async () => {
  const payload = await buildExportPayload(
    "project",
    doc({ clips: [print("c0", 0, 0), print("c1", 1, 0.55)] }),
    settings,
    "preview"
  );
  const spec = payload.spec as {
    clips: { shadow?: { frames?: { duration: number }[] } }[];
    overlayVideos: { shadow?: { frames?: { duration: number }[] } }[];
  };

  // One shadow picture per output frame, on track 0 and above it.
  for (const shadow of [spec.clips[0].shadow, spec.overlayVideos[0].shadow]) {
    const frames = shadow!.frames!;
    expect(frames.length).toBe(Math.round(0.4 * FPS));
    expect(frames[0].duration).toBeCloseTo(1 / FPS, 6);
  }

  // Track 0 starts on a frame, so its first shadow is the clip at opacity 0.
  // The upper clip starts at 0.55 s, 13.2 frames in: its first frame shows at
  // frame 14, a 30th of a second into the clip, where the fade is under way.
  const png = (name: string) => payload.pngs.find((p) => p.name === name)!.blob;
  expect(await maxAlpha(png("shadow_c0_f0.png"))).toBe(0);
  expect(await maxAlpha(png("shadow_ov0_f0.png"))).toBeGreaterThan(20);
});
