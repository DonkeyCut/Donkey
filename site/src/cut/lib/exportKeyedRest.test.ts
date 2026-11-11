import { beforeAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runExport, type ExportSpec, type RenderHandle } from "../server/exportPipeline";
import { installSkiaRaster } from "./headless/skiaRaster";
import { buildExportPayload, EXPORT_PRESETS, presetSettings } from "./exportClient";
import type { ExportDoc } from "./renderSnapshot";
import type { MediaAsset, VideoClip } from "./types";

// A track-0 clip whose keys slide it in from past the frame's edge. The keys
// place the picture by absolute center, so where its region rests never
// shows; the preview draws the whole picture wherever the keys carry it, and
// the export has to as well.

const tools = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

beforeAll(async () => {
  expect(await installSkiaRaster()).toBe(true);
});

const slide: VideoClip = {
  id: "c0", assetId: "v", track: 0, start: 0, in: 0, out: 1, muted: true, fit: "fill",
  frame: { x: 1.05, y: 0.2, w: 0.4, h: 0.6 },
  kf: [
    { t: 0, x: 1.25, y: 0.5, scale: 1, rotation: 0, opacity: 1 },
    { t: 0.4, x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 },
  ],
} as VideoClip;

const doc: ExportDoc = {
  aspect: "16:9",
  background: "#F1EFEA",
  assets: [{
    id: "v", fileName: "v.mp4", name: "V", type: "video", duration: 1, width: 160, height: 90, url: "",
    color: { matrix: "bt709", fullRange: false, bitDepth: 8, detected: "rec709" },
  } as MediaAsset],
  clips: [slide],
  audioClips: [],
  overlays: [],
  subtitles: { cues: [], showOnVideo: false, showOnTimeline: false },
};

test.skipIf(!tools)("a track-0 clip keyed in from off the frame shows where its keys put it", async () => {
  const mediaDir = await mkdtemp(path.join(os.tmpdir(), "cut-keyed-rest-media-"));
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cut-keyed-rest-job-"));
  try {
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=160x90:r=30:d=1", "-pix_fmt", "yuv420p", path.join(mediaDir, "v.mp4")]);
    const settings = { ...presetSettings(EXPORT_PRESETS.find((p) => p.id === "tiktok")!, "16:9"), width: 160, height: 90 };
    const payload = await buildExportPayload("project", doc, settings, "export");
    const job: RenderHandle = { tmpDir, outPath: path.join(tmpDir, "out.mp4"), progress: 0, log: [] };
    await runExport(job, payload.spec as ExportSpec, (file) => path.join(mediaDir, file));

    // The middle row of a frame after the slide lands: red across x 0.3–0.7.
    const row = new Uint8Array(
      execFileSync("ffmpeg", ["-v", "error", "-ss", "0.8", "-i", job.outPath, "-frames:v", "1", "-vf", "crop=160:2:0:44", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
    );
    const red = [...Array(160).keys()].filter((x) => row[x * 3] > 150 && row[x * 3 + 1] < 90);
    expect(red.length).toBeGreaterThan(0);
    expect(red[0] / 160).toBeCloseTo(0.3, 1);
    expect((red.at(-1)! + 1) / 160).toBeCloseTo(0.7, 1);
  } finally {
    await rm(mediaDir, { recursive: true, force: true });
    await rm(tmpDir, { recursive: true, force: true });
  }
}, 60_000);
