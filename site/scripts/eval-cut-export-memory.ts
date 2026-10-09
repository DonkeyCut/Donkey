#!/usr/bin/env bun
/**
 * Export memory eval: does an ffmpeg export's memory stay flat as the
 * timeline grows?
 *
 * An edit cut from one long phone recording is the common case, and the shape
 * that runs an export out of memory: every cut reads the same file, and an
 * encode graph holds memory for every cut it carries. So the eval exports the
 * same recording cut 60 and 180 times, in source order and reordered, through
 * the production `runExport` — real probes, an H.264 delivery, passes and
 * their join — with `ffmpeg` on PATH wrapped by the system `time`, and takes
 * the peak memory of the largest ffmpeg process each export ran.
 *
 * Budgets: 180 cuts peak within GROWTH_MAX of 60 cuts, no export over
 * PEAK_MAX_MB in either order, and every file decodes clean,
 * upright, with the frame count its duration asks for. Enforced by default;
 * it needs ffmpeg and ffprobe and runs in a few minutes with no network.
 *
 *   npm run eval:cut-export-memory [--ffmpeg path] [--out path] [--no-enforce]
 */

import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { retimeOf } from "@donkeycut/effects-kit";
import { runExport, type ExportSpec, type RenderHandle } from "../src/cut/server/exportPipeline";
import { SETTINGS } from "../src/lib/config/registry";

const SITE = path.resolve(import.meta.dir, "..");
const REPORT = path.resolve(SITE, "..", "evals", "cut-export-memory.latest-report.json");

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const OUT = arg("--out") ?? REPORT;
const ENFORCE = !argv.includes("--no-enforce");

/** The ffmpeg the export runs; its ffprobe sits beside it or on PATH. */
const FFMPEG = path.resolve(arg("--ffmpeg") ?? (spawnSync("which", ["ffmpeg"], { encoding: "utf8" }).stdout.trim() || "ffmpeg"));
const FFPROBE = ((beside) => (spawnSync(beside, ["-version"]).status === 0 ? beside : "ffprobe"))(
  path.join(path.dirname(FFMPEG), "ffprobe")
);

/** The source: a portrait phone recording, stored landscape with a 90°
 * display rotation the way a phone writes it, long enough for 180 cuts. */
const SRC = { width: 720, height: 1280, fps: 30, seconds: 160 };
/** Both counts are past what one pass holds at this size, so the growth
 * budget compares exports rendered in passes. */
const CUT_COUNTS = [60, 180] as const;
/** How much more 180 cuts may peak at than 60 cuts of the same file. */
const GROWTH_MAX = 1.5;
/** The most any export may peak at: the pass budget, which a reordered edit
 * spends on frames waiting for their turn, plus the process around it. */
const PEAK_MAX_MB = SETTINGS.cutExportPasses.default.holdMB + 512;

type Order = "in order" | "reordered";

const MAC = process.platform === "darwin";

// ── Tools ───────────────────────────────────────────────────────────────────

const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 << 20 });
  if (r.status !== 0) {
    throw new Error(`${path.basename(cmd)} ${args.slice(0, 6).join(" ")}… failed:\n${r.stderr.slice(-600)}`);
  }
  return r.stdout;
};

/** A PATH entry whose `ffmpeg` runs the real one under the system `time`,
 * each process writing its peak into `logs`. */
async function wrapFfmpeg(dir: string, logs: string): Promise<string> {
  const bin = path.join(dir, "bin");
  await mkdir(bin, { recursive: true });
  const timeFlag = MAC ? "-l" : "-v";
  await writeFile(
    path.join(bin, "ffmpeg"),
    `#!/bin/sh\nexec /usr/bin/time ${timeFlag} -o "${logs}/$$.time" "${FFMPEG}" "$@"\n`
  );
  await chmod(path.join(bin, "ffmpeg"), 0o755);
  await writeFile(path.join(bin, "ffprobe"), `#!/bin/sh\nexec "${FFPROBE}" "$@"\n`);
  await chmod(path.join(bin, "ffprobe"), 0o755);
  return bin;
}

/** The largest peak among the runs logged since the last call, in MB: the
 * footprint on macOS (it counts what the compressor holds), peak RSS on
 * Linux. */
async function largestPeak(logs: string): Promise<{ peakMB: number; runs: number }> {
  const files = await readdir(logs);
  let peak = 0;
  for (const f of files) {
    const text = await readFile(path.join(logs, f), "utf8");
    const found = MAC
      ? text.match(/(\d+)\s+peak memory footprint/)
      : text.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
    if (found) {
      peak = Math.max(peak, Number(found[1]) / (MAC ? 1e6 : 1e3));
    }
    await rm(path.join(logs, f));
  }
  return { peakMB: Math.round(peak), runs: files.length };
}

// ── The source ──────────────────────────────────────────────────────────────

/** The first H.264 encoder this ffmpeg carries. */
function h264Encoder(): string {
  const out = run(FFMPEG, ["-hide_banner", "-encoders"]);
  const found = ["libx264", "h264_videotoolbox"].find((e) => out.includes(` ${e} `));
  if (!found) {
    throw new Error(`${FFMPEG} has no H.264 encoder`);
  }
  return found;
}

/** Noisy test pattern with sound, keyframes every two seconds, B-frames where
 * the encoder makes them — decoding it costs what a real recording does. */
function makeSource(dir: string): string {
  const flat = path.join(dir, "flat.mp4");
  const file = path.join(dir, "source.mp4");
  const enc = h264Encoder();
  run(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc2=size=${SRC.height}x${SRC.width}:rate=${SRC.fps},noise=alls=16:allf=t+u`,
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", String(SRC.seconds), "-ac", "2",
    "-c:v", enc, ...(enc === "libx264" ? ["-preset", "veryfast", "-bf", "2"] : ["-b:v", "6M"]),
    "-g", String(SRC.fps * 2), "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    flat,
  ]);

  // Stored landscape, shown portrait: the display matrix a phone writes.
  run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-display_rotation", "90", "-i", flat, "-c", "copy", file]);
  return file;
}

// ── The edit ────────────────────────────────────────────────────────────────

/** `n` cuts spread over the source, each under 4s, deterministic run to run. */
function cutsOf(n: number, order: Order): ExportSpec["clips"] {
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const step = (SRC.seconds - 5) / n;
  const clips: ExportSpec["clips"] = [];
  for (let i = 0; i < n; i++) {
    const from = +(i * step + 0.2 + rnd() * 0.3).toFixed(3);
    const len = Math.min(step * 0.9, 2 + rnd() * 2);
    clips.push({ file: "source.mp4", in: from, out: +(from + len).toFixed(3), muted: false });
  }

  // Reordered: the cuts play in a shuffled order, the way an edit tightens a
  // talk by moving its best lines up.
  if (order === "reordered") {
    for (let i = clips.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [clips[i], clips[j]] = [clips[j], clips[i]];
    }
  }
  return clips;
}

// ── The finished file ───────────────────────────────────────────────────────

interface Checked {
  frames: number;
  width: number;
  height: number;
  rotation: number;
  audioSeconds: number;
  decodeErrors: string;
}

function check(file: string): Checked {
  const meta = JSON.parse(
    run(FFPROBE, [
      "-v", "error", "-count_frames",
      "-show_entries", "stream=codec_type,width,height,nb_read_frames,duration:stream_side_data=rotation",
      "-of", "json", file,
    ])
  ) as {
    streams: {
      codec_type: string;
      width?: number;
      height?: number;
      nb_read_frames?: string;
      duration?: string;
      side_data_list?: { rotation?: number }[];
    }[];
  };
  const video = meta.streams.find((s) => s.codec_type === "video");
  const audio = meta.streams.find((s) => s.codec_type === "audio");
  const decoded = spawnSync(FFMPEG, ["-hide_banner", "-v", "error", "-i", file, "-f", "null", "-"], { encoding: "utf8" });
  return {
    frames: Number(video?.nb_read_frames ?? 0),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    rotation: video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0,
    audioSeconds: Number(audio?.duration ?? 0),
    decodeErrors: decoded.stderr.trim(),
  };
}

// ── Run ─────────────────────────────────────────────────────────────────────

interface Result extends Checked {
  cuts: number;
  order: Order;
  peakMB: number;
  ffmpegRuns: number;
  seconds: number;
  duration: number;
  expectedFrames: number;
}

const dir = await mkdtemp(path.join(tmpdir(), "cut-export-memory-"));
const results: Result[] = [];
try {
  const logs = path.join(dir, "logs");
  await mkdir(logs);
  const bin = await wrapFfmpeg(dir, logs);
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

  console.log(`source: ${SRC.width}x${SRC.height} ${SRC.seconds}s, ${h264Encoder()} — ${FFMPEG}`);
  const source = makeSource(dir);
  await largestPeak(logs);

  for (const order of ["in order", "reordered"] as const) {
    for (const cuts of CUT_COUNTS) {
      const clips = cutsOf(cuts, order);
      const duration = clips.reduce((s, c) => s + retimeOf(c).len, 0);
      const jobDir = await mkdtemp(path.join(dir, "job-"));
      const job: RenderHandle = { tmpDir: jobDir, outPath: path.join(jobDir, "out.mp4"), progress: 0, log: [] };
      const spec: ExportSpec = {
        projectId: "eval",
        width: SRC.width,
        height: SRC.height,
        fps: SRC.fps,
        crf: 24,
        preset: "veryfast",
        duration,
        clips,
        audio: [],
        overlays: [],
      };

      const t0 = performance.now();
      await runExport(job, spec, () => source);
      const seconds = (performance.now() - t0) / 1000;
      const { peakMB, runs } = await largestPeak(logs);
      const checked = check(job.outPath);
      await rm(jobDir, { recursive: true, force: true });

      const result: Result = {
        cuts,
        order,
        peakMB,
        ffmpegRuns: runs,
        seconds: +seconds.toFixed(1),
        duration: +duration.toFixed(3),
        expectedFrames: Math.round(duration * SRC.fps),
        ...checked,
      };
      results.push(result);
      console.log(
        `  ${String(cuts).padStart(3)} cuts ${order.padEnd(9)}  peak ${String(peakMB).padStart(5)} MB` +
          `  ${runs} ffmpeg runs  ${seconds.toFixed(1)}s  ${checked.frames}/${result.expectedFrames} frames`
      );
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

// ── Budgets ─────────────────────────────────────────────────────────────────

const breaches: string[] = [];
const peakOf = (cuts: number, order: Order) => results.find((r) => r.cuts === cuts && r.order === order)!.peakMB;
const [few, many] = CUT_COUNTS;

// The file: every frame laid, decodable, upright, with its sound.
for (const r of results) {
  const name = `${r.cuts} cuts ${r.order}`;
  if (Math.abs(r.frames - r.expectedFrames) > 1) {
    breaches.push(`${name}: ${r.frames} frames, expected ${r.expectedFrames}`);
  }
  if (r.width !== SRC.width || r.height !== SRC.height || r.rotation !== 0) {
    breaches.push(`${name}: ${r.width}x${r.height} rotated ${r.rotation}°, expected ${SRC.width}x${SRC.height} upright`);
  }
  if (Math.abs(r.audioSeconds - r.duration) > 0.1) {
    breaches.push(`${name}: ${r.audioSeconds}s of sound, expected ${r.duration}s`);
  }
  if (r.decodeErrors) {
    breaches.push(`${name}: decode errors: ${r.decodeErrors.slice(0, 200)}`);
  }
}

// Growth: more cuts of the same file cost no more memory.
for (const order of ["in order", "reordered"] as const) {
  const ratio = peakOf(many, order) / peakOf(few, order);
  if (ratio > GROWTH_MAX) {
    breaches.push(`${order}: ${many} cuts peak ${ratio.toFixed(2)}x of ${few} cuts (max ${GROWTH_MAX}x)`);
  }
}

// Ceiling: in either order, an export holds what one pass may.
for (const r of results) {
  if (r.peakMB > PEAK_MAX_MB) {
    breaches.push(`${r.cuts} cuts ${r.order}: peak ${r.peakMB} MB (max ${PEAK_MAX_MB} MB)`);
  }
}

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ source: SRC, budgets: { GROWTH_MAX, PEAK_MAX_MB }, results, breaches }, null, 2) + "\n");
for (const b of breaches) {
  console.log(`  ✗ ${b}`);
}
console.log(`\n${breaches.length === 0 ? "within budget" : `${breaches.length} breaches`} — report at ${OUT}`);
if (breaches.length > 0 && ENFORCE) {
  process.exit(1);
}
