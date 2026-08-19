import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mediaPath } from "./projects";
import { assertGraphSafe, fexpr } from "./filterGraph";
import { num, round } from "./util";

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let err = "";
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after 60s.`));
    }, 60_000);
    timer.unref();
    p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-2000)));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(
        e.message.includes("ENOENT")
          ? new Error("ffmpeg was not found. Install it with: brew install ffmpeg")
          : e
      );
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(err.split("\n").slice(-3).join("\n")));
    });
  });
}

export function probeDims(file: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=p=0",
      file,
    ]);
    let out = "";
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      resolve({ width: 1080, height: 1920 });
    }, 30_000);
    timer.unref();
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => {
      clearTimeout(timer);
      const [w, h] = out.trim().split(",").map(Number);
      resolve({ width: w || 1080, height: h || 1920 });
    });
    p.on("error", () => {
      clearTimeout(timer);
      resolve({ width: 1080, height: 1920 });
    });
  });
}

export interface FreezeFraming {
  fit: "fit" | "fill";
  /** How far the picture zooms past the size the frame fits it to (1 = none). */
  zoom?: number;
  panX: number;
  panY: number;
}

/**
 * Render a still-video clip from one frame of a project media file
 * (a freeze frame), written into the project's media folder.
 *
 * When `frame` is given the still is composited exactly as the preview shows
 * it — letterboxed (fit) or crop-panned (fill) into the project frame — so
 * the capture is locked to the aspect at capture time. Switching the project
 * aspect later letterboxes the baked still; capture another to re-fit.
 */
export async function makeFreezeFrame(
  projectId: string,
  sourceFile: string,
  srcTime: number,
  duration: number,
  frame?: { w: number; h: number },
  framing?: FreezeFraming
): Promise<{ fileName: string; duration: number; width: number; height: number }> {
  const src = mediaPath(projectId, sourceFile);
  const dur = Math.min(10, Math.max(0.5, duration));
  const stampTime = Math.max(0, srcTime);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "veditor-freeze-"));
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const fileName = `freeze-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${crypto.randomUUID().slice(0, 4)}.mp4`;
  try {
    const png = path.join(tmp, "frame.png");
    await run("ffmpeg", ["-y", "-ss", stampTime.toFixed(3), "-i", src, "-frames:v", "1", png]);

    let vf: string | null = null;
    if (frame) {
      const { w, h } = frame;
      // The clip's own framing, baked: the picture meets the frame the way the
      // preview shows it — covering or fitted, zoomed, panned. Same chain as
      // the export graph's `boxFraming`.
      const cover = framing?.fit === "fill";
      const z = Math.max(1, Math.min(4, framing?.zoom ?? 1));
      const even = (n: number) => 2 * Math.round(n / 2);
      const kx = (0.5 + (framing?.panX ?? 0) / 2).toFixed(4);
      const ky = (0.5 + (framing?.panY ?? 0) / 2).toFixed(4);
      const crop = `,crop=${fexpr(`min(iw,${w})`)}:${fexpr(`min(ih,${h})`)}:(iw-ow)*${kx}:(ih-oh)*${ky}`;
      vf = cover
        ? `scale=${even(w * z)}:${even(h * z)}:force_original_aspect_ratio=increase${crop}`
        : `scale=${even(w * z)}:${even(h * z)}:force_original_aspect_ratio=decrease` +
          (z > 1.0001 ? crop : "") +
          `,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`;
    }

    await run("ffmpeg", [
      "-y",
      "-loop", "1",
      "-i", png,
      "-t", dur.toFixed(3),
      "-r", "30",
      ...(vf ? ["-vf", assertGraphSafe(vf)] : []),
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-pix_fmt", "yuv420p",
      mediaPath(projectId, fileName),
    ]);
    if (frame) return { fileName, duration: dur, width: frame.w, height: frame.h };
    const dims = await probeDims(png);
    return { fileName, duration: dur, width: dims.width, height: dims.height };
  } finally {
    void rm(tmp, { recursive: true, force: true });
  }
}

/** Media duration in seconds via ffprobe (0 when unknown). */
export function probeDuration(file: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      file,
    ]);
    let out = "";
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      resolve(0);
    }, 30_000);
    timer.unref();
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => {
      clearTimeout(timer);
      resolve(parseFloat(out) || 0);
    });
    p.on("error", () => {
      clearTimeout(timer);
      resolve(0);
    });
  });
}

interface CaptureRun {
  ok: boolean;
  timedOut: boolean;
  stderr: string;
}

/** Run ffmpeg keeping the whole stderr — the frame/silence reports stream
 * there. A timeout resolves instead of rejecting so callers can salvage
 * partial output; a missing binary still maps to the install hint. */
function runCapture(args: string[], timeoutMs: number): Promise<CaptureRun> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args);
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    p.stderr.on("data", (d) => {
      if (err.length < 2_000_000) err += d.toString();
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(
        e.message.includes("ENOENT")
          ? new Error("ffmpeg was not found. Install it with: brew install ffmpeg")
          : e
      );
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, timedOut, stderr: err });
    });
  });
}

const errTail = (stderr: string) => stderr.trim().split("\n").slice(-3).join("\n");

export interface SilenceRange {
  start: number;
  end: number;
  duration: number;
}

/** Find silent stretches in a media file's audio (ffmpeg silencedetect).
 * Times are absolute source seconds. */
export async function detectSilence(
  projectId: string,
  sourceFile: string,
  opts: { from: number; to: number; thresholdDb: number; minSilence: number }
): Promise<SilenceRange[]> {
  const { from, to, thresholdDb, minSilence } = opts;
  const r = await runCapture(
    [
      "-hide_banner", "-nostats", "-loglevel", "info",
      ...(from > 0 ? ["-ss", num(from)] : []),
      "-t", num(to - from),
      "-i", mediaPath(projectId, sourceFile),
      "-vn", "-sn", "-dn",
      "-af", `silencedetect=n=${thresholdDb}dB:d=${num(minSilence)}`,
      "-f", "null", "-",
    ],
    60_000
  );
  if (!r.ok) {
    if (/does not contain any stream|matches no streams|Cannot find a matching stream/i.test(r.stderr))
      throw new Error("This file has no audio track.");
    throw new Error(
      r.timedOut ? "Silence detection timed out — try a shorter range." : errTail(r.stderr)
    );
  }
  const silences: SilenceRange[] = [];
  let open: number | null = null;
  for (const line of r.stderr.split("\n")) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    if (s) {
      open = Math.max(from, from + parseFloat(s[1]));
      continue;
    }
    const e = /silence_end: (-?[\d.]+)/.exec(line);
    if (e && open !== null) {
      const end = Math.min(to, from + parseFloat(e[1]));
      if (end > open) silences.push({ start: round(open), end: round(end), duration: round(end - open) });
      open = null;
    }
  }
  // Silence still open at the end of the range closes there.
  if (open !== null && to > open)
    silences.push({ start: round(open), end: round(to), duration: round(to - open) });
  return silences;
}

/** Pull a media file's audio track off as a small mono AAC stream so the
 * assistant can hear it inline. Works for audio and video sources alike — the
 * video image never travels, and 32 kbps keeps ~50 min under the model's
 * inline cap. Times are absolute source seconds; an empty `to` runs to the end. */
export function extractAudio(
  projectId: string,
  sourceFile: string,
  opts: { from: number; to?: number },
): Promise<Buffer> {
  const { from, to } = opts;
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", [
      "-hide_banner", "-nostats", "-loglevel", "error",
      ...(from > 0 ? ["-ss", num(from)] : []),
      ...(to !== undefined ? ["-t", num(to - from)] : []),
      "-i", mediaPath(projectId, sourceFile),
      "-vn", "-sn", "-dn",
      "-ac", "1", "-ar", "24000", "-c:a", "aac", "-b:a", "32k",
      "-f", "adts", "-",
    ]);
    const chunks: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error("Reading the audio timed out — try a shorter from/to range."));
    }, 120_000);
    timer.unref();
    p.stdout.on("data", (d: Buffer) => chunks.push(d));
    p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-4000)));
    p.on("error", (e) =>
      reject(
        e.message.includes("ENOENT")
          ? new Error("ffmpeg was not found. Install it with: brew install ffmpeg")
          : e,
      ),
    );
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && chunks.length > 0) return resolve(Buffer.concat(chunks));
      if (/does not contain any stream|matches no streams|Cannot find a matching stream/i.test(err))
        return reject(new Error("This file has no audio track."));
      reject(new Error(errTail(err) || "Could not read the audio."));
    });
  });
}
