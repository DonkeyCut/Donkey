import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { effectPreviewState } from "@donkeycut/effects-kit";
import { runExport, type ExportSpec, type RenderHandle } from "./exportPipeline";

// The bundled LGPL ffmpeg the app ships, ahead of anything else on PATH.
const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../vendor/donkey-tools");
const W = 64;
const H = 64;
const FPS = 30;

/** A solid-color clip file, `secs` long. */
const solid = (dir: string, name: string, color: string, secs: number) => {
  const r = spawnSync(path.join(TOOLS, "ffmpeg"), [
    "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=${W}x${H}:r=${FPS}:d=${secs}`,
    "-pix_fmt", "yuv420p", "-c:v", "mpeg4", "-q:v", "2", path.join(dir, name),
  ]);
  expect(r.status).toBe(0);
};

/** The center pixel of every frame of `file`, as [r, g, b]. */
const centers = (file: string): [number, number, number][] => {
  const r = spawnSync(path.join(TOOLS, "ffmpeg"), ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], {
    maxBuffer: 1 << 28,
  });
  expect(r.status).toBe(0);
  const size = W * H * 3;
  const at = (H / 2) * W * 3 + (W / 2) * 3;
  return [...Array(Math.floor(r.stdout.length / size)).keys()].map((i) => {
    const o = i * size + at;
    return [r.stdout[o], r.stdout[o + 1], r.stdout[o + 2]];
  });
};

describe("cuts between frames", () => {
  test.skipIf(!existsSync(path.join(TOOLS, "ffmpeg")))(
    "every clip starts on the frame the preview starts it on, and its effects keep the preview's clock",
    async () => {
      const mediaDir = await mkdtemp(path.join(os.tmpdir(), "cut-frames-media-"));
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cut-frames-job-"));
      const PATH = process.env.PATH;
      process.env.PATH = `${TOOLS}:${PATH}`;
      try {
        solid(mediaDir, "red.mp4", "red", 4);
        const still = spawnSync(path.join(TOOLS, "ffmpeg"), [
          "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=green:s=${W}x${H}`, "-frames:v", "1", path.join(mediaDir, "green.png"),
        ]);
        expect(still.status).toBe(0);
        solid(mediaDir, "blue.mp4", "blue", 2);

        // Red to 3.5s, a green still flashing 0.0433s, then blue under a black
        // strobe. The flash covers frames 105 and 106; the cut after it falls
        // at frame 106.3, so blue starts on frame 107. The flash pops black
        // on its first frame and shows green on its second.
        const POP = 0.0433;
        const STROBE = { effect: "flash", amount: 1, tone: "black", rate: 5.5 } as const;
        const spec: ExportSpec = {
          projectId: "cut-frames",
          width: W,
          height: H,
          fps: FPS,
          crf: 20,
          preset: "ultrafast",
          duration: 4.5433,
          background: "#000000",
          clips: [
            { file: "red.mp4", in: 0, out: 3.5, muted: true, fit: "fill" },
            { file: "green.png", in: 0, out: POP, muted: true, fit: "fill", image: true, effects: [{ ...STROBE, rate: 15 }] },
            { file: "blue.mp4", in: 0, out: 1, muted: true, fit: "fill", effects: [STROBE] },
          ],
          // ffmpeg's own ProRes writer, so the encoder is the same in every
          // build whichever one an earlier export probed.
          codec: "prores",
          container: "mov",
          audio: [],
          overlays: [],
          effects: [],
          captions: [],
        };
        const job: RenderHandle = { tmpDir, outPath: path.join(tmpDir, "out.mov"), progress: 0, log: [] };
        await runExport(job, spec, (file) => path.join(mediaDir, file));

        const px = centers(job.outPath);
        const hue = ([r, g, b]: [number, number, number]) =>
          r + g + b < 60 ? "dark" : r > g && r > b ? "red" : g > b ? "green" : "blue";
        expect(px.slice(103, 107).map(hue)).toEqual(["red", "red", "dark", "green"]);

        // From frame 107 the strobe darkens exactly where the preview does,
        // reading each frame at its time since blue's start.
        const want = [...Array(20).keys()].map((n) => {
          const tLocal = (107 + n) / FPS - (3.5 + POP);
          return (effectPreviewState("flash", 1, tLocal, undefined, undefined, 1, STROBE).flash ?? 0) > 0.5 ? "dark" : "blue";
        });
        expect(px.slice(107, 127).map(hue)).toEqual(want);
      } finally {
        process.env.PATH = PATH;
        await rm(mediaDir, { recursive: true, force: true });
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    120_000
  );

  test.skipIf(!existsSync(path.join(TOOLS, "ffmpeg")))(
    "footage at another rate shows the source frame the preview shows, from any in point",
    async () => {
      const mediaDir = await mkdtemp(path.join(os.tmpdir(), "cut-frames-media-"));
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cut-frames-job-"));
      const PATH = process.env.PATH;
      process.env.PATH = `${TOOLS}:${PATH}`;
      try {
        // A 25 fps clip whose frame i is grey level 8i: the preview shows, at
        // each 30 fps frame, the last source frame that has started by then.
        const STEP = 8;
        const made = spawnSync(path.join(TOOLS, "ffmpeg"), [
          "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=25:d=1.2`,
          "-vf", `geq=lum='16+N*${STEP}':cb=128:cr=128`, "-pix_fmt", "yuv420p", "-c:v", "mpeg4", "-q:v", "1",
          path.join(mediaDir, "count.mp4"),
        ]);
        expect(made.status).toBe(0);
        // In at 0.03s, between source frames 0 and 1: the clip opens on
        // frame 0, already on screen there.
        const IN = 0.03;
        const spec: ExportSpec = {
          projectId: "cut-frames",
          width: W,
          height: H,
          fps: FPS,
          crf: 20,
          preset: "ultrafast",
          duration: 1,
          background: "#000000",
          clips: [{ file: "count.mp4", in: IN, out: IN + 1, muted: true, fit: "fill" }],
          codec: "prores",
          container: "mov",
          audio: [],
          overlays: [],
          effects: [],
          captions: [],
        };
        const job: RenderHandle = { tmpDir, outPath: path.join(tmpDir, "out.mov"), progress: 0, log: [] };
        await runExport(job, spec, (file) => path.join(mediaDir, file));

        // Each frame's grey, read back as the source frame it came from.
        const shown = centers(job.outPath).slice(0, 30).map(([r]) => Math.round((r * 219) / 255 / STEP));
        const want = [...Array(30).keys()].map((k) => Math.floor((IN + k / FPS) * 25 + 1e-9));
        expect(shown).toEqual(want);
      } finally {
        process.env.PATH = PATH;
        await rm(mediaDir, { recursive: true, force: true });
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    120_000
  );

  test.skipIf(!existsSync(path.join(TOOLS, "ffmpeg")))(
    "an animated element shows each of its pictures on its own frame",
    async () => {
      const mediaDir = await mkdtemp(path.join(os.tmpdir(), "cut-frames-media-"));
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cut-frames-job-"));
      const PATH = process.env.PATH;
      process.env.PATH = `${TOOLS}:${PATH}`;
      try {
        solid(mediaDir, "black.mp4", "black", 3);
        // Thirty pictures one frame each from 1s, picture k grey level 16 + 7k.
        const N = 30;
        const STEP = 7;
        const png = (name: string, color: string) =>
          expect(
            spawnSync(path.join(TOOLS, "ffmpeg"), [
              "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=${W}x${H}`, "-frames:v", "1", path.join(tmpDir, name),
            ]).status
          ).toBe(0);
        png("blank.png", "black@0.0");
        for (let k = 0; k < N; k++) {
          const v = (16 + STEP * k).toString(16).padStart(2, "0");
          png(`f${k}.png`, `0x${v}${v}${v}`);
        }
        const spec: ExportSpec = {
          projectId: "cut-frames",
          width: W,
          height: H,
          fps: FPS,
          crf: 20,
          preset: "ultrafast",
          duration: 3,
          background: "#000000",
          clips: [{ file: "black.mp4", in: 0, out: 3, muted: true, fit: "fill" }],
          codec: "prores",
          container: "mov",
          audio: [],
          overlays: [
            {
              x: 0,
              y: 0,
              start: 1,
              end: 2,
              blank: "blank.png",
              frames: [...Array(N).keys()].map((k) => ({ file: `f${k}.png`, duration: 1 / FPS })),
            },
          ],
          effects: [],
          captions: [],
        };
        const job: RenderHandle = { tmpDir, outPath: path.join(tmpDir, "out.mov"), progress: 0, log: [] };
        await runExport(job, spec, (file) => path.join(mediaDir, file));

        // Frame 30 + k shows picture k: from one frame to the next the grey
        // climbs one picture's step (a repeat would hold, a skip would climb
        // two), read through the round trip to video levels.
        const px = centers(job.outPath).map(([r]) => r);
        expect(px[29]).toBeLessThan(px[30] - STEP / 2);
        const climbs = px.slice(30, 30 + N).slice(1).map((r, k) => r - px[30 + k]);
        for (const c of climbs) {
          expect(c).toBeGreaterThan(STEP / 2);
          expect(c).toBeLessThan(STEP * 1.5);
        }
      } finally {
        process.env.PATH = PATH;
        await rm(mediaDir, { recursive: true, force: true });
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    120_000
  );
});
