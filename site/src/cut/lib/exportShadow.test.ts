import { beforeAll, expect, test } from "bun:test";
import { installSkiaRaster } from "./headless/skiaRaster";
import { buildExportPayload, EXPORT_PRESETS, presetSettings } from "./exportClient";
import { createRasterCanvas, decodeRasterImage } from "./raster";
import type { ExportDoc } from "./renderSnapshot";
import type { MediaAsset, VideoClip } from "./types";

// A clip's box shadow fades with the clip. The preview draws the shadow at
// the clip's opacity, so a print keyed in from opacity 0 casts nothing on its
// first frame; an export that painted the shadow at full ink showed an empty
// outlined box where the picture had not faded in yet.

beforeAll(async () => {
  expect(await installSkiaRaster()).toBe(true);
});

const print = (id: string, track: number): VideoClip => ({
  id, assetId: "v", track, start: 0, in: 0, out: 1, muted: true, fit: "fill",
  frame: { x: 0.3, y: 0.2, w: 0.4, h: 0.5 },
  boxStyle: { borderWidth: 14, borderColor: "#FFFFFF", shadow: { blur: 30, y: 10, opacity: 0.3 } },
  kf: [
    { t: 0, x: 0.5, y: 0.45, scale: 1.25, rotation: -12, opacity: 0 },
    { t: 0.35, x: 0.5, y: 0.45, scale: 1, rotation: -4, opacity: 1 },
  ],
} as VideoClip);

const doc: ExportDoc = {
  aspect: "16:9",
  background: "#F1EFEA",
  assets: [{
    id: "v", fileName: "v.mp4", name: "V", type: "video", duration: 2, width: 1920, height: 1080, url: "",
    color: { matrix: "bt709", fullRange: false, bitDepth: 8, detected: "rec709" },
  } as MediaAsset],
  clips: [print("c0", 0), print("c1", 1)],
  audioClips: [],
  overlays: [],
  subtitles: { cues: [], showOnVideo: false, showOnTimeline: false },
};

/** The strongest alpha anywhere in a painted PNG. */
async function maxAlpha(blob: Blob): Promise<number> {
  const img = await decodeRasterImage(blob);
  const canvas = createRasterCanvas(img!.width, img!.height);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  ctx.drawImage(img!.source, 0, 0);
  const px = ctx.getImageData(0, 0, img!.width, img!.height).data;
  let max = 0;
  for (let i = 3; i < px.length; i += 4) max = Math.max(max, px[i]);
  return max;
}

test("a clip keyed in from opacity 0 casts no shadow on its first frame", async () => {
  const settings = { ...presetSettings(EXPORT_PRESETS.find((p) => p.id === "tiktok")!, "16:9"), width: 320, height: 180 };
  const payload = await buildExportPayload("project", doc, settings, "export");
  const png = (name: string) => payload.pngs.find((p) => p.name === name)!.blob;

  // Track 0 and an upper track paint their shadows the same way.
  for (const tag of ["shadow_c0", "shadow_ov0"]) {
    expect(await maxAlpha(png(`${tag}_f0.png`))).toBe(0);
    expect(await maxAlpha(png(`${tag}_f10.png`))).toBeGreaterThan(10);
  }
}, 30_000);
