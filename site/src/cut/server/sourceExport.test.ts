import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { exportSourceFiles } from "./sourceExport";
import { runExport, type RenderHandle } from "./exportPipeline";
import { ALL_FORMATS, BufferSource, Input } from "mediabunny";

const available = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
let dir = "";
let source = "";
beforeAll(async () => {
  if (!available) return;
  dir = await mkdtemp(path.join(tmpdir(), "donkey-trim-test-"));
  source = path.join(dir, "source.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "12", "-c:v", "libx264", "-g", "60", "-bf", "2", "-b:v", "140k", "-c:a", "aac", "-b:a", "48k", source]);
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
const handle = (name: string): RenderHandle => ({ tmpDir: dir, outPath: path.join(dir, name), progress: 0, log: [] });
const hashes = (file: string) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_packets", "-show_data_hash", "sha256", "-show_entries", "packet=codec_type,data_hash", "-of", "json", file], { encoding: "utf8" })).packets as { codec_type: string; data_hash: string }[];

test.skipIf(!available)("non-keyframe trims preserve compressed packets, duration, dimensions and sync", async () => {
  const job = handle("trim.mp4");
  await runExport(job, {
    projectId: "trim-test", target: "export", width: 320, height: 240, fps: 30, crf: 19, preset: "medium", duration: 5.284,
    sourceSegments: [{ file: "source.mp4", from: 3.137, to: 8.421 }],
    clips: [{ file: "source.mp4", in: 3.137, out: 8.421, muted: false }], audio: [], overlays: [],
  }, () => source);
  expect(job.proc).toBeUndefined();
  expect(job.progress).toBe(1);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", job.outPath], { encoding: "utf8" }));
  expect(probe.streams[0]).toMatchObject({ width: 320, height: 240, codec_name: "h264" });
  expect(Number(probe.format.duration)).toBeCloseTo(5.284, 3);
  for (const stream of probe.streams) {
    expect(Number(stream.start_time)).toBeCloseTo(0, 2);
    expect(Number(stream.duration)).toBeCloseTo(5.284, 3);
  }
  const original = new Set(hashes(source).map((p) => p.data_hash));
  const copied = hashes(job.outPath);
  expect(copied.length).toBeGreaterThan(100);
  for (const packet of copied) expect(original.has(packet.data_hash)).toBe(true);
  expect((await stat(job.outPath)).size).toBeLessThan((await stat(source)).size);
  expect(execFileSync("ffmpeg", ["-v", "error", "-i", job.outPath, "-f", "null", "-"], { encoding: "utf8" })).toBe("");
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(await readFile(job.outPath)) });
  try { expect(await input.computeDuration()).toBeCloseTo(5.284, 3); }
  finally { input.dispose(); }
  const frameHashes = (file: string, filter: string[]) => execFileSync("ffmpeg", ["-v", "error", "-i", file, ...filter, "-an", "-f", "framemd5", "-"], { encoding: "utf8" })
    .split("\n").filter((line) => line && !line.startsWith("#")).map((line) => line.split(",").at(-1)?.trim());
  expect(frameHashes(job.outPath, [])).toEqual(frameHashes(source, ["-vf", "trim=start=3.137:end=8.421"]));
  const pcm = (file: string, filter: string[]) => execFileSync("ffmpeg", ["-v", "error", "-i", file, ...filter, "-vn", "-f", "f32le", "-"], { maxBuffer: 4 * 1024 * 1024 });
  const expectedAudio = pcm(source, ["-af", "atrim=start=3.137:end=8.421"]);
  const actualAudio = pcm(job.outPath, []);
  expect(actualAudio.length).toBeGreaterThanOrEqual(expectedAudio.length);
  let maxError = 0;
  for (let i = 0; i < expectedAudio.length; i += 4) {
    maxError = Math.max(maxError, Math.abs(expectedAudio.readFloatLE(i) - actualAudio.readFloatLE(i)));
  }
  expect(maxError).toBeLessThan(0.0001);
});

test.skipIf(!available)("video-only trims preserve rotation metadata", async () => {
  const rotated = path.join(dir, "rotated.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-display_rotation", "90", "-i", source, "-map", "0:v", "-c", "copy", rotated]);
  const job = handle("rotated-trim.mp4");
  expect(await exportSourceFiles(job, () => rotated, [{ file: "rotated.mp4", from: 0, to: 4.017 }], "h264")).toBe(true);
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(await readFile(job.outPath)) });
  try {
    expect(await input.getPrimaryAudioTrack()).toBeNull();
    const video = (await input.getPrimaryVideoTrack())!;
    expect(await video.getDisplayWidth()).toBe(240);
    expect(await video.getDisplayHeight()).toBe(320);
    expect(await input.computeDuration()).toBeCloseTo(4.017, 3);
  } finally { input.dispose(); }
});

test.skipIf(!available)("codec changes decline packet copy before creating an output", async () => {
  const job = handle("hevc.mp4");
  expect(await exportSourceFiles(job, () => source, [{ file: "source.mp4", from: 1, to: 8 }], "hevc")).toBe(false);
  expect(stat(job.outPath)).rejects.toThrow();
});

test.skipIf(!available)("cancellation stops copying", async () => {
  const job = { ...handle("canceled.mp4"), error: "Export canceled." };
  expect(exportSourceFiles(job, () => source, [{ file: "source.mp4", from: 1, to: 8 }], "h264")).rejects.toThrow("canceled");
});

test.skipIf(!available)("whole sources export without changing encoded media", async () => {
  const job = handle("whole.mp4");
  expect(await exportSourceFiles(job, () => source, [{ file: "source.mp4", from: 0, to: 12 }], "h264")).toBe(true);
  const original = new Set(hashes(source).map((p) => p.data_hash));
  for (const packet of hashes(job.outPath)) expect(original.has(packet.data_hash)).toBe(true);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_format", "-of", "json", job.outPath], { encoding: "utf8" }));
  expect(Number(probe.format.duration)).toBeCloseTo(12, 3);
});

test.skipIf(!available)("reordered source sequences copy video and join audio at exact sample boundaries", async () => {
  const job = handle("sequence.mp4");
  const segments = [{ file: "source.mp4", from: 4.137, to: 8 }, { file: "source.mp4", from: 0, to: 2.421 }];
  expect(await exportSourceFiles(job, () => source, segments, "h264", 48_000)).toBe(true);
  const original = new Set(hashes(source).filter((p) => p.codec_type === "video").map((p) => p.data_hash));
  for (const packet of hashes(job.outPath).filter((p) => p.codec_type === "video")) expect(original.has(packet.data_hash)).toBe(true);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", job.outPath], { encoding: "utf8" }));
  expect(Number(probe.format.duration)).toBeCloseTo(6.284, 3);
  expect(probe.streams.find((s: { codec_type: string }) => s.codec_type === "audio")).toMatchObject({ sample_rate: "48000", channels: 1 });
  const frameHashes = (file: string, filter: string[]) => execFileSync("ffmpeg", ["-v", "error", "-i", file, ...filter, "-an", "-fps_mode", "passthrough", "-f", "framemd5", "-"], { encoding: "utf8" })
    .split("\n").filter((line) => line && !line.startsWith("#")).map((line) => line.split(",").at(-1)?.trim());
  expect(frameHashes(job.outPath, [])).toEqual(segments.flatMap((s) => frameHashes(source, ["-vf", `trim=start=${s.from}:end=${s.to}`])));
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(await readFile(job.outPath)) });
  try { expect(await input.computeDuration()).toBeCloseTo(6.284, 3); } finally { input.dispose(); }
  const pcm = (file: string, filter: string[]) => execFileSync("ffmpeg", ["-v", "error", "-i", file, ...filter, "-vn", "-f", "f32le", "-"], { maxBuffer: 4 * 1024 * 1024 });
  const expected = Buffer.concat(segments.map((s) => pcm(source, ["-af", `atrim=start=${s.from}:end=${s.to}`])));
  const actual = pcm(job.outPath, []);
  expect(actual.length).toBeGreaterThanOrEqual(expected.length);
  let error = 0, energy = 0;
  for (let i = 0; i < expected.length; i += 4) {
    error += (expected.readFloatLE(i) - actual.readFloatLE(i)) ** 2;
    energy += expected.readFloatLE(i) ** 2;
  }
  expect(error / energy).toBeLessThan(0.05);
});

test.skipIf(!available)("incompatible interior cuts use the compositor", async () => {
  const job = handle("needs-render.mp4");
  expect(await exportSourceFiles(job, () => source, [{ file: "source.mp4", from: 0, to: 3.137 }, { file: "source.mp4", from: 4.421, to: 8 }], "h264")).toBe(false);
  expect(stat(job.outPath)).rejects.toThrow();
});

test.skipIf(!available)("metadata probing preserves fractional cadence without requiring a decoder", async () => {
  const { sourceExportProfile } = await import("../lib/exportRender");
  const { registerBlobFile, forgetRegistered } = await import("../lib/backend/browser/registry");
  const fractional = path.join(dir, "fractional.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-i", source, "-t", "4", "-r", "30000/1001", "-c:v", "libx264", "-c:a", "aac", "-ar", "44100", "-ac", "1", fractional]);
  const file = new File([await readFile(fractional)], "fractional.mp4");
  const url = registerBlobFile("test-source-profile", file);
  try {
    const profile = await sourceExportProfile({
      assets: [{ id: "a", name: "source", fileName: "fractional.mp4", type: "video", duration: 4, url, sizeBytes: file.size }],
      clips: [{ id: "c", assetId: "a", track: 0, start: 0, in: 0, out: 4, muted: false }],
    }, () => url);
    expect(profile.fps).toBeCloseTo(30000 / 1001, 6);
    expect(profile).toMatchObject({ codec: "h264", audioSampleRate: 44100, audioChannels: 1 });
  } finally { forgetRegistered("test-source-profile"); }
});

test.skipIf(!available)("HEVC sources keep their encoded video", async () => {
  const hevc = path.join(dir, "hevc-source.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-i", source, "-t", "2", "-an", "-c:v", "libx265", "-x265-params", "log-level=error", "-tag:v", "hvc1", hevc]);
  const job = handle("hevc-copy.mp4");
  expect(await exportSourceFiles(job, () => hevc, [{ file: "hevc-source.mp4", from: 0.137, to: 1.721 }], "hevc")).toBe(true);
  const original = new Set(hashes(hevc).map((packet) => packet.data_hash));
  for (const packet of hashes(job.outPath)) expect(original.has(packet.data_hash)).toBe(true);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", job.outPath], { encoding: "utf8" }));
  expect(probe.streams[0].codec_name).toBe("hevc");
  expect(Number(probe.format.duration)).toBeCloseTo(1.584, 3);
});
