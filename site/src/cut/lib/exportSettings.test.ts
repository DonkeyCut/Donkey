import { expect, test } from "bun:test";
import { choiceSettings, estimateExportBytes, EXPORT_QUICK_PRESETS, resolutionOptions, sourceFrame } from "@/cut/lib/exportClient";
import { sourceFrameRateKey } from "@/cut/lib/exportRender";
import type { MediaAsset, VideoClip } from "@/cut/lib/types";

const asset: MediaAsset = {
  id: "source", fileName: "source.mp4", name: "Source", type: "video",
  duration: 904.28, width: 320, height: 240, url: "",
};
const clip: VideoClip = { id: "clip", assetId: asset.id, start: 0, track: 0, in: 0, out: 855.3, muted: false };
const best = EXPORT_QUICK_PRESETS[1].choice;

test("Source preserves low-resolution footage within the project aspect", () => {
  expect(sourceFrame("4:3", [clip], [asset])).toEqual({ width: 320, height: 240 });
  expect(sourceFrame("16:9", [clip], [asset])).toEqual({ width: 426, height: 240 });
  expect(sourceFrame("9:16", [clip], [{ ...asset, width: 240, height: 320 }]))
    .toEqual({ width: 240, height: 426 });
});

test("converting a source refreshes the export's metadata probe", () => {
  expect(sourceFrameRateKey({ clips: [clip], assets: [asset] }))
    .not.toBe(sourceFrameRateKey({ clips: [clip], assets: [{ ...asset, fileName: "converted.mp4" }] }));
});

test("source export budgets bytes from the original compression", () => {
  const source = { videoBitrate: 140_000, audioBitrate: 48_000 };
  const options = resolutionOptions("16:9", [clip], [asset]);
  const settings = choiceSettings(best, options, 30, source);
  expect(settings).toMatchObject({ width: 426, height: 240, bitrate: 140_000, audioBitrate: 48_000 });
  expect(estimateExportBytes(settings, 855.3)).toBeLessThan(21_000_000);
});

test("the modal offers lower resolutions and marks true upscales", () => {
  const options = resolutionOptions("16:9", [clip], [{ ...asset, width: 1920, height: 1080 }]);
  for (const id of ["720", "480", "360", "240"]) {
    expect(options.find((o) => o.id === id)?.height).toBe(Number(id));
    expect(options.find((o) => o.id === id)?.upscale).toBeUndefined();
  }
  expect(resolutionOptions("16:9", [clip], [asset]).find((o) => o.id === "480")?.upscale).toBe(true);
});

test("custom bitrate and explicit upscale presets keep their chosen budgets", () => {
  const options = resolutionOptions("16:9", [clip], [asset]);
  const source = { videoBitrate: 140_000, audioBitrate: 48_000 };
  expect(choiceSettings({ ...best, bitrateMbps: 2 }, options, 30, source).bitrate).toBe(2_000_000);
  expect(choiceSettings(EXPORT_QUICK_PRESETS[2].choice, options, 30, source).bitrate).toBeUndefined();
  expect(choiceSettings(EXPORT_QUICK_PRESETS[4].choice, options, 30, source).audioBitrate).toBeUndefined();
});
