import { spawn } from "node:child_process";
import { access, constants, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** Does a file/dir exist? (stat, coerced to a boolean.) */
export async function exists(p: string) {
  return stat(p).then(
    () => true,
    () => false
  );
}

/**
 * Atomically write `value` as pretty JSON to `filePath`, keeping a `.bak`
 * mirror for corruption recovery. Two invariants make recovery safe by
 * construction:
 *  - The temp name is unique per write, so concurrent writers to the same path
 *    each rename their own temp in (last writer wins) instead of racing on one
 *    shared temp and having the loser's rename hit ENOENT.
 *  - `.bak` is written from the very bytes we are committing — never copied
 *    from the on-disk file. So a corrupt file can never overwrite a good backup
 *    (the failure mode when recovery re-saves a doc recovered *from* the .bak).
 */
export async function writeJsonAtomic(filePath: string, value: unknown) {
  const json = JSON.stringify(value, null, 2);
  const tmp = `${filePath}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, json);
  await writeFile(`${filePath}.bak`, json).catch(() => {});
  await rename(tmp, filePath);
}

/** First executable *file* named `name` on PATH, or null. Directories carry the
 * execute bit too, so a like-named directory must not shadow the real CLI. */
export async function findOnPath(name: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      const s = await stat(candidate); // follows symlinks
      if (!s.isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // absent or not executable — keep looking
    }
  }
  return null;
}

/**
 * First variant of `base` (stem, stem-1, stem-2, …) whose resolved path does
 * not already exist. Used to avoid clobbering when copying/saving media.
 */
export async function uniqueName(base: string, pathFor: (name: string) => string) {
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length) || "media";
  let name = base;
  for (let n = 1; await exists(pathFor(name)); n++) name = `${stem}-${n}${ext}`;
  return name;
}

/** ffmpeg time/value formatting: millisecond precision, fixed 3 decimals. */
export const num = (n: number) => (Math.round(n * 1000) / 1000).toFixed(3);

/** Round to hundredths (cue/timeline times). */
export const round = (n: number) => Math.round(n * 100) / 100;

/** An ffmpeg atempo chain reaching `speed`. A single atempo spans only
 * 0.5–2.0×, so factors are chained to cover the full 0.25–4× range. */
export function atempoChain(speed: number) {
  const parts: string[] = [];
  let s = speed;
  while (s > 2) {
    parts.push("atempo=2.0");
    s /= 2;
  }
  while (s < 0.5) {
    parts.push("atempo=0.5");
    s *= 2;
  }
  parts.push(`atempo=${num(s)}`);
  return parts.join(",");
}

/**
 * The first video stream's color tags (e.g. primaries "bt2020", transfer
 * "arib-std-b67"), or null when the probe fails or the file has no video
 * stream. Untagged fields come back undefined.
 */
export function videoColorInfo(
  file: string
): Promise<{ primaries?: string; transfer?: string; matrix?: string } | null> {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=color_primaries,color_transfer,color_space",
      "-of", "json",
      file,
    ]);
    let out = "";
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      resolve(null);
    }, 30_000);
    timer.unref();
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      try {
        const s = JSON.parse(out).streams?.[0];
        resolve(
          s ? { primaries: s.color_primaries, transfer: s.color_transfer, matrix: s.color_space } : null
        );
      } catch {
        resolve(null);
      }
    });
    p.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/**
 * The first video stream's coded size, or null when the probe fails or the file
 * has no video. Reported in display orientation: ffprobe gives coded dimensions,
 * so a phone portrait clip tagged with a 90° display matrix reads back as
 * landscape, and the rotation is applied here rather than left to each caller.
 */
export function videoDimensions(
  file: string
): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height:stream_side_data=rotation",
      "-of", "json",
      file,
    ]);
    let out = "";
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      resolve(null);
    }, 30_000);
    timer.unref();
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      try {
        const s = JSON.parse(out).streams?.[0];
        const width = Number(s?.width);
        const height = Number(s?.height);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          return resolve(null);
        }
        const rotation = Number(
          (s?.side_data_list ?? []).find((d: { rotation?: unknown }) => d?.rotation != null)
            ?.rotation ?? 0
        );
        const quarterTurned = Math.abs(rotation) % 180 === 90;
        resolve(quarterTurned ? { width: height, height: width } : { width, height });
      } catch {
        resolve(null);
      }
    });
    p.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/**
 * Bytes of decoded picture one second of a file's video comes to — width ×
 * height × 1.5 for yuv420p, times the frame rate. A pass that has to hold a
 * stretch of decoded frames at once sizes that stretch by this. Null when the
 * probe fails or the file carries no picture.
 */
export function videoDecodeCost(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate",
      "-of", "json",
      file,
    ]);
    let out = "";
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      resolve(null);
    }, 30_000);
    timer.unref();
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      try {
        const s = JSON.parse(out).streams?.[0];
        const width = Number(s?.width);
        const height = Number(s?.height);
        if (!(width > 0) || !(height > 0)) return resolve(null);
        const ratio = (v: unknown) => {
          const [n, d] = String(v ?? "").split("/");
          const fps = Number(n) / (Number(d) || 1);
          return Number.isFinite(fps) && fps > 0 && fps < 1000 ? fps : 0;
        };
        const fps = ratio(s?.avg_frame_rate) || ratio(s?.r_frame_rate) || 30;
        resolve(width * height * 1.5 * fps);
      } catch {
        resolve(null);
      }
    });
    p.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/** How long a media file runs, in seconds, or null when the probe fails. */
export function mediaDuration(file: string): Promise<number | null> {
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
      resolve(null);
    }, 30_000);
    timer.unref();
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => {
      clearTimeout(timer);
      const seconds = Number(out.trim());
      resolve(code === 0 && Number.isFinite(seconds) && seconds >= 0 ? seconds : null);
    });
    p.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/**
 * Whether a media file carries a stream of the given kind ("a" audio /
 * "v" video). Resolves false only when ffprobe reports no such stream; a
 * probe that errors is reported by `onProbeError` so callers can decide
 * whether to assume the stream is present rather than silently dropping it.
 */
export function hasStream(
  file: string,
  kind: "a" | "v",
  onProbeError?: (err: Error) => void
): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", kind,
      "-show_entries", "stream=codec_type",
      "-of", "csv=p=0",
      file,
    ]);
    let out = "";
    // A probe that never returns is a probe failure, not "no stream".
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      onProbeError?.(new Error(`ffprobe timed out for ${file}`));
      resolve(false);
    }, 30_000);
    timer.unref();
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => {
      clearTimeout(timer);
      // A non-zero exit means the probe itself failed, not "no stream".
      if (code !== 0) onProbeError?.(new Error(`ffprobe exited ${code} for ${file}`));
      resolve(out.trim().length > 0);
    });
    p.on("error", (err) => {
      clearTimeout(timer);
      onProbeError?.(err);
      resolve(false);
    });
  });
}
