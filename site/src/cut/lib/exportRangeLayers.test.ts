import { beforeAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runExport, type ExportSpec, type RenderHandle } from "../server/exportPipeline";
import { installSkiaRaster } from "./headless/skiaRaster";
import { buildExportPayload, EXPORT_PRESETS, presetSettings } from "./exportClient";
import type { ExportDoc } from "./renderSnapshot";
import type { AudioClip, MediaAsset, VideoClip } from "./types";

// A range that ends just before a framed, shadowed layer comes on, over a
// soundtrack. The layer shows on no frame of the range, and the range still
// renders: a long export's passes end on piece starts like this one.

const tools = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

beforeAll(async () => {
  expect(await installSkiaRaster()).toBe(true);
});

const asset = (id: string): MediaAsset =>
  ({
    id, fileName: `${id}.mp4`, name: id, type: "video", duration: 3, width: 320, height: 180, url: "",
    color: { matrix: "bt709", fullRange: false, bitDepth: 8, detected: "rec709" },
  }) as MediaAsset;

// A framed card that drops in, as the gallery's photo-stack templates lay them.
const card = (id: string, assetId: string, track: number, start: number, seconds: number, x: number): VideoClip =>
  ({
    id, assetId, track, start, in: 0, out: seconds, muted: true, fit: "fill",
    frame: { x, y: 0.2, w: 0.26, h: 0.42 },
    boxStyle: { borderWidth: 14, borderColor: "#FFFFFF", shadow: { blur: 30, y: 10, opacity: 0.3 } },
    kf: [
      { t: 0, x: x + 0.13, y: 0.62, scale: 1.25, rotation: 9, opacity: 1, ease: "power3.out" },
      { t: 0.35, x: x + 0.13, y: 0.41, scale: 1, rotation: 3, opacity: 1 },
    ],
  }) as VideoClip;

const music = { id: "m", fileName: "m.m4a", name: "m", type: "audio", duration: 10.8, url: "" } as MediaAsset;
const soundtrack = { id: "au", assetId: "m", start: 0, in: 0, out: 10.8, volume: 1 } as AudioClip;

const doc: ExportDoc = {
  aspect: "16:9",
  background: "#F1EFEA",
  assets: [asset("a"), asset("b"), asset("c"), music],
  clips: [card("c1", "a", 1, 5.6, 2.4, 0.14), card("c2", "b", 2, 6.1, 1.9, 0.37), card("c3", "c", 3, 6.6, 1.4, 0.6)],
  audioClips: [soundtrack],
  overlays: [],
  subtitles: { cues: [], showOnVideo: false, showOnTimeline: false },
};

test.skipIf(!tools)("a range ending before a layer comes on renders", async () => {
  const mediaDir = await mkdtemp(path.join(os.tmpdir(), "cut-range-layers-media-"));
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cut-range-layers-job-"));
  try {
    for (const id of ["a", "b", "c"]) {
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=3", "-pix_fmt", "yuv420p", path.join(mediaDir, `${id}.mp4`)]);
    }
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=f=220:d=10.8", "-c:a", "aac", path.join(mediaDir, "m.m4a")]);
    const settings = { ...presetSettings(EXPORT_PRESETS.find((p) => p.id === "tiktok")!, "16:9"), width: 640, height: 360 };
    const payload = await buildExportPayload("project", doc, settings, "export");
    // The layers' frames, borders and shadows go where the job reads them.
    for (const png of payload.pngs) {
      await writeFile(path.join(tmpDir, path.basename(png.name)), Buffer.from(await png.blob.arrayBuffer()));
    }
    const spec = { ...(payload.spec as ExportSpec), range: { start: 5.4, end: 5.6 } };
    const job: RenderHandle = { tmpDir, outPath: path.join(tmpDir, "out.mp4"), progress: 0, log: [] };
    await runExport(job, spec, (file) => path.join(mediaDir, file));

    const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", job.outPath]).toString());
    expect(seconds).toBeCloseTo(0.2, 1);
  } finally {
    await rm(mediaDir, { recursive: true, force: true });
    await rm(tmpDir, { recursive: true, force: true });
  }
}, 30_000);
