import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runExport, type ExportSpec, type RenderHandle } from "./exportPipeline";

// The graph tests assert shapes; this one hands the real graph to a real
// ffmpeg. It synthesizes every asset kind from lavfi sources, builds one
// project that uses every ExportSpec feature — framing crops, regions,
// transitions, edge animations, looks, grades, masks (painted and subject),
// keyframed poses, borders, shadows, overlay videos, elements (static and
// slideshow), effects, captions, an audio bed with ducking, whole-video
// fades, a background color, a gap — and renders it end to end. A filter
// ffmpeg rejects, a broken option value, or an unconnected pad fails here
// before it can fail an export.

const available = (cmd: string) =>
  spawnSync(cmd, ["-version"], { stdio: "ignore" }).status === 0;
const tools = available("ffmpeg") && available("ffprobe");

const ff = (args: string[]) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")} failed:\n${r.stderr}`);
};

const probe = (file: string) => {
  const r = spawnSync(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "format=duration",
      "-show_entries", "stream=codec_type,width,height",
      "-of", "json",
      file,
    ],
    { encoding: "utf8" }
  );
  if (r.status !== 0) throw new Error(`ffprobe failed:\n${r.stderr}`);
  return JSON.parse(r.stdout) as {
    format: { duration: string };
    streams: { codec_type: string; width?: number; height?: number }[];
  };
};

const W = 320;
const H = 568;

describe("export pipeline end to end", () => {
  test.skipIf(!tools)(
    "a project using every pipeline feature renders through real ffmpeg",
    async () => {
      const mediaDir = await mkdtemp(path.join(os.tmpdir(), "cut-e2e-media-"));
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cut-e2e-job-"));
      try {
        // ---- Footage, stills, and the audio bed (project media) ----------
        const vid = (name: string, src: string, hz: number, secs: number) =>
          ff([
            "-f", "lavfi", "-i", `${src}=size=320x240:rate=24:duration=${secs}`,
            "-f", "lavfi", "-i", `sine=frequency=${hz}:sample_rate=44100:duration=${secs}`,
            "-shortest", "-pix_fmt", "yuv420p", "-c:a", "aac",
            path.join(mediaDir, name),
          ]);
        vid("a.mp4", "testsrc2", 440, 3);
        vid("b.mp4", "smptebars", 660, 3);
        vid("o.mp4", "testsrc", 880, 3);
        ff([
          "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=1:duration=1",
          "-frames:v", "1", path.join(mediaDir, "img.png"),
        ]);
        ff([
          "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=44100:duration=6",
          "-c:a", "aac", path.join(mediaDir, "music.m4a"),
        ]);

        // ---- Client-painted stills and the person matte (job.tmpDir) -----
        const png = (name: string, chain: string) =>
          ff(["-f", "lavfi", "-i", chain, "-frames:v", "1", path.join(tmpDir, name)]);
        png("mask.png", `color=c=white:s=${W}x${H},format=gray`);
        png("omask.png", "color=c=0xC0C0C0:s=160x160,format=gray");
        png("el.png", `color=c=red@0.5:s=${W}x${H},format=rgba`);
        png("f0.png", "color=c=blue:s=120x80,format=rgba");
        png("f1.png", "color=c=green:s=120x80,format=rgba");
        png("blank.png", "color=c=black@0.0:s=120x80,format=rgba");
        png("border.png", `color=c=yellow@0.6:s=${W}x${H},format=rgba`);
        png("oborder.png", "color=c=cyan@0.6:s=128x256,format=rgba");
        png("shadow.png", `color=c=black@0.4:s=${W}x${H},format=rgba`);
        png("cap.png", `color=c=white@0.8:s=${W}x${H},format=rgba`);
        png("sub_blank.png", `color=c=black@0.0:s=${W}x${H},format=rgba`);
        ff([
          "-f", "lavfi", "-i", `color=c=gray:s=${W}x${H}:d=6:r=24`,
          "-pix_fmt", "yuv420p", path.join(tmpDir, "matte.mp4"),
        ]);

        // Timeline: 1.6s (sped-up cover crop) + 2s (graded, masked, keyed)
        // + 1s gap + 1.5s regioned still = 6.1s.
        const spec: ExportSpec = {
          projectId: "e2e",
          width: W,
          height: H,
          fps: 24,
          crf: 30,
          preset: "ultrafast",
          duration: 6.1,
          fadeIn: 0.3,
          fadeOut: 0.3,
          background: "#102030",
          clips: [
            {
              file: "a.mp4", in: 0, out: 2, muted: false, volume: 0.8,
              fit: "fill", zoom: 1.4, panX: 0.3, panY: -0.2,
              speed: 1.25,
              look: "vhs", lookAmount: 0.7,
              animIn: { style: "pop", seconds: 0.4 },
              transition: 0.5, transitionStyle: "crosszoom",
            },
            {
              file: "b.mp4", in: 0, out: 2, muted: false,
              fit: "fit",
              grade: { brightness: 5, contrast: 8, saturation: -10, temperature: 12, hue: 10 },
              mask: { file: "mask.png" },
              kf: [
                { t: 0, x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 },
                { t: 1.5, x: 0.6, y: 0.4, scale: 0.8, rotation: 15, opacity: 1 },
              ],
              animOut: { style: "fade", seconds: 0.4 },
              transition: 0.4, transitionStyle: "wipeleft",
            },
            { file: "", in: 0, out: 1, muted: true, hidden: true },
            {
              file: "img.png", in: 0, out: 1.5, muted: true, image: true,
              frame: { x: 0.5, y: 0.45, w: 0.45, h: 0.5 }, fit: "fill",
              mask: { subject: { feather: 1 } },
              border: "border.png",
              shadow: { file: "shadow.png" },
            },
          ],
          overlayVideos: [
            {
              file: "o.mp4", in: 0.2, out: 1.8, start: 0.8, track: 1,
              frame: { x: 0.55, y: 0.5, w: 0.4, h: 0.45 },
              fit: "fill", zoom: 1.3, panX: -0.4,
              muted: false, volume: 0.5, speed: 2,
              headFade: 0.3,
              mask: { file: "omask.png" },
              border: "oborder.png",
              kf: [
                { t: 0, x: 0.75, y: 0.7, scale: 1, rotation: 0, opacity: 1 },
                { t: 0.6, x: 0.65, y: 0.75, scale: 1.1, rotation: -10, opacity: 1 },
              ],
            },
          ],
          audio: [
            { file: "music.m4a", in: 0, out: 4, start: 0, volume: 0.6, fadeIn: 0.2, fadeOut: 0.4 },
            { file: "a.mp4", in: 0, out: 1, start: 2, volume: 1, duck: 0.3, speed: 1.1 },
          ],
          overlays: [
            { file: "el.png", start: 0.5, end: 2.5, lane: 1 },
            {
              frames: [
                { file: "f0.png", duration: 0.5 },
                { file: "f1.png", duration: 0.5 },
              ],
              blank: "blank.png", x: 40, y: 60, start: 1, end: 2,
              subject: { invert: true, feather: 2 }, lane: 0,
            },
          ],
          behindMask: { file: "matte.mp4", from: 0.5 },
          effects: [
            { effect: "vignette", amount: 0.6, start: 0.5, end: 2, lane: 0 },
            { effect: "zoom", amount: 0.4, focus: { x: 0.5, y: 0.4 }, ramp: 0.4, start: 2, end: 3, lane: 1 },
          ],
          captions: [
            { file: "cap.png", start: 0.3, end: 1.2 },
            { file: "cap.png", start: 1.4, end: 2.0 },
          ],
        };

        const job: RenderHandle = {
          tmpDir,
          outPath: path.join(tmpDir, "out.mp4"),
          progress: 0,
          log: [],
        };
        await runExport(job, spec, (file) => path.join(mediaDir, file));

        const info = await stat(job.outPath);
        expect(info.size).toBeGreaterThan(0);
        const meta = probe(job.outPath);
        expect(Number(meta.format.duration)).toBeGreaterThan(spec.duration - 0.3);
        expect(Number(meta.format.duration)).toBeLessThan(spec.duration + 0.3);
        const video = meta.streams.find((s) => s.codec_type === "video");
        expect(video?.width).toBe(W);
        expect(video?.height).toBe(H);
        expect(meta.streams.some((s) => s.codec_type === "audio")).toBe(true);
      } finally {
        await rm(mediaDir, { recursive: true, force: true });
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    120_000
  );
});
