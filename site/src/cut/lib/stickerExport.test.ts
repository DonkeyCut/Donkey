import { afterAll, beforeAll, expect, test } from "bun:test";
import type { StickerOverlay } from "@donkeycut/effects-kit";
import { installSkiaRaster } from "./headless/skiaRaster";
import { buildExportPayload, EXPORT_PRESETS, presetSettings } from "./exportClient";
import { renderProjectFrame } from "./exportRender";
import { createRasterCanvas, decodeRasterImage, rasterCanvasToPng } from "./raster";
import type { ExportDoc } from "./renderSnapshot";
import type { MediaAsset } from "./types";

// A sticker reaches an export as its asset's URL, read when the element is
// drawn. The preview skips a sticker it cannot read and asks again next frame;
// an export draws each frame once, so a read that fails there has to stop it
// by name — the worker's renders came back with the title and without the
// doodles drawn around it.

const SERVED = "https://media.test/sparkles.png";
const UNSIGNED = "https://media.test/unsigned.png";
const realFetch = globalThis.fetch;

beforeAll(async () => {
  expect(await installSkiaRaster()).toBe(true);

  // A white block on transparent, the shape of a doodle sheet.
  const sheet = createRasterCanvas(64, 96);
  const ctx = sheet.getContext("2d") as CanvasRenderingContext2D;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 64, 96);
  const png = await (await rasterCanvasToPng(sheet)).arrayBuffer();

  // The served URL answers with the picture; anything else gets what a read
  // without its signature gets.
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    String(input) === SERVED
      ? new Response(png, { headers: { "content-type": "image/png" } })
      : new Response("Unauthorized", { status: 401 })) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

const sticker = (assetId: string): StickerOverlay => ({
  id: `o-${assetId}`, kind: "sticker", assetId, name: "Sparkles left",
  start: 0, end: 2, x: 0.5, y: 0.5, w: 0.5, h: 0.5,
});

const docOf = (assetId: string, url: string): ExportDoc => ({
  aspect: "16:9",
  assets: [{
    id: assetId, name: "Sparkles left", type: "image", origin: "sticker", duration: 0,
    width: 64, height: 96, fileName: "sparkles-left.png", url,
  } as MediaAsset],
  clips: [], audioClips: [], overlays: [sticker(assetId)],
  subtitles: { cues: [], showOnVideo: false, showOnTimeline: false },
});

const size = { width: 320, height: 180 };
const settings = () => presetSettings(EXPORT_PRESETS.find((p) => p.id === "tiktok")!, "16:9");

test("the spec export stops on a sticker it cannot read", async () => {
  await expect(buildExportPayload("project", docOf("stx-spec-unread", UNSIGNED), settings(), "export")).rejects.toThrow(
    /The sticker "Sparkles left" could not be read \(HTTP 401\)/
  );
});

test("the tab export stops on a sticker it cannot read", async () => {
  await expect(renderProjectFrame(docOf("stx-tab-unread", UNSIGNED), 1, size, (a) => a.url)).rejects.toThrow(
    /The sticker "Sparkles left" could not be read \(HTTP 401\)/
  );
});

test("a sticker that reads draws in both exports", async () => {
  const payload = await buildExportPayload("project", docOf("stx-spec-read", SERVED), settings(), "export");
  const still = await decodeRasterImage(payload.pngs.find((p) => p.name === "overlay_0.png")!.blob);
  const sheet = createRasterCanvas(still!.width, still!.height);
  const sctx = sheet.getContext("2d") as CanvasRenderingContext2D;
  sctx.drawImage(still!.source, 0, 0);
  expect(sctx.getImageData(still!.width / 2, still!.height / 2, 1, 1).data[3]).toBeGreaterThan(200);

  const frame = await renderProjectFrame(docOf("stx-tab-read", SERVED), 1, size, (a) => a.url);
  const ink = (frame.getContext("2d") as CanvasRenderingContext2D).getImageData(160, 90, 1, 1).data;
  expect(ink[0]).toBeGreaterThan(200);
});
