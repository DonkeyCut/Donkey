// Packaging a finished render as an HLS ladder.
//
// A share plays through HLS rather than the flattened mp4 for two reasons. The
// edge refuses to cache a single object past 512 MB (worker/cf/media.ts), which
// a long or 4K cut passes easily — so the one file that most needs the cache is
// the one that never gets it, while segments of a few megabytes always do. And
// a ladder is what lets one asset serve a phone on a weak cellular link and a
// desktop on a 4K panel, which a fixed-bitrate file cannot.
//
// The ladder is built FROM the rendered master, not from the timeline. By that
// point the pixels are already upright, already BT.709 SDR, and already
// composited, so this stage is a pure transcode and never has to know what a
// clip is.
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runFfmpeg, type RenderHandle } from "./exportPipeline";
import { hasStream, videoDimensions } from "./util";

/** Segment length. Six seconds is the common VOD choice: long enough that
 * per-segment request overhead stays small on a long cut, short enough that a
 * player switching rungs commits to only a few seconds of the wrong bitrate. */
export const HLS_SEGMENT_SECONDS = 6;

/** Audio is encoded per variant rather than as one shared rendition. It costs
 * this much extra per rung, which buys variants that are each self-contained —
 * no audio group to mis-associate, and a rung switch that can never desync. */
const AUDIO_KBPS = 128;

/**
 * One rung, addressed by the SHORT side so portrait and landscape ladders are
 * the same ladder. `kbps` is the video bitrate for a 16:9 frame at that short
 * side; an aspect that carries more pixels scales up from it.
 */
export interface Rung {
  name: string;
  shortSide: number;
  kbps: number;
}

export const HLS_RUNGS: Rung[] = [
  { name: "360p", shortSide: 360, kbps: 800 },
  { name: "540p", shortSide: 540, kbps: 1400 },
  { name: "720p", shortSide: 720, kbps: 2800 },
  { name: "1080p", shortSide: 1080, kbps: 5000 },
  { name: "1440p", shortSide: 1440, kbps: 9000 },
  { name: "2160p", shortSide: 2160, kbps: 18000 },
];

/** Rungs published in the first pass. The share becomes watchable once these
 * land, so they are the ones a phone would pick anyway. */
export const FIRST_PASS_RUNGS = 3;

export interface PlannedRung extends Rung {
  width: number;
  height: number;
  /** Video bitrate after scaling `kbps` for this frame's pixel count. */
  videoKbps: number;
}

const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));

/**
 * The rungs worth building for a source of this size: every rung below the
 * source's short side, plus one capped AT the source. Upscaling is never
 * useful — it spends encode time and storage to add no detail — so the top rung
 * is the source itself.
 */
export function planLadder(width: number, height: number): PlannedRung[] {
  const sourceShort = Math.min(width, height);
  const aspect = width / height;
  const plan: PlannedRung[] = [];
  for (const rung of HLS_RUNGS) {
    const capped = Math.min(rung.shortSide, sourceShort);
    const portrait = height > width;
    const w = even(portrait ? capped : capped * aspect);
    const h = even(portrait ? capped / aspect : capped);
    // `kbps` is tuned for 16:9, whose pixel count at a given short side is the
    // same in both orientations. A squarer or wider frame at that short side
    // carries a different pixel count and needs proportionally different bits.
    const reference = ((capped * capped) * 16) / 9;
    const videoKbps = Math.round(rung.kbps * Math.min(2.5, Math.max(0.5, (w * h) / reference)));
    plan.push({ ...rung, width: w, height: h, videoKbps });
    if (capped >= sourceShort) break;
  }
  return plan;
}

/** `#EXT-X-STREAM-INF` line plus the variant path it introduces. */
export interface Variant {
  inf: string;
  uri: string;
}

/** Pull the variant entries out of a master playlist ffmpeg wrote, so passes
 * that ran separately can be merged into one master. */
function parseVariants(master: string): Variant[] {
  const lines = master.split("\n").map((l) => l.trim());
  const out: Variant[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
    const uri = lines[i + 1];
    if (uri && !uri.startsWith("#")) out.push({ inf: lines[i], uri });
  }
  return out;
}

/** A master playlist listing `variants`, ordered lowest bitrate first so a
 * player with no measurement yet starts on the rung most likely to play. */
function masterPlaylist(variants: Variant[]): string {
  const bandwidth = (v: Variant) => Number(/BANDWIDTH=(\d+)/.exec(v.inf)?.[1] ?? 0);
  const ordered = [...variants].sort((a, b) => bandwidth(a) - bandwidth(b));
  return ["#EXTM3U", "#EXT-X-VERSION:3", ...ordered.flatMap((v) => [v.inf, v.uri]), ""].join("\n");
}

/**
 * Encode `rungs` out of `source` into `outDir`, in ONE ffmpeg run.
 *
 * The single run is the point: the graph decodes the source once and splits it
 * to every rung. Running ffmpeg per rung would re-decode the whole file each
 * time, which on a 4K master is most of the cost of the job and would saturate
 * a render pool that only has four slots.
 */
export async function encodeRungs(
  handle: RenderHandle,
  source: string,
  outDir: string,
  rungs: PlannedRung[],
  duration: number,
  onProgress?: (fraction: number) => void
): Promise<Variant[]> {
  await Promise.all(rungs.map((r) => mkdir(path.join(outDir, r.name), { recursive: true })));
  const withAudio = await hasStream(source, "a");

  const split = `[0:v]split=${rungs.length}${rungs.map((_, i) => `[s${i}]`).join("")}`;
  const scales = rungs.map(
    (r, i) => `[s${i}]scale=${r.width}:${r.height}:flags=lanczos[o${i}]`
  );

  const maps: string[] = [];
  for (let i = 0; i < rungs.length; i++) maps.push("-map", `[o${i}]`);
  if (withAudio) for (let i = 0; i < rungs.length; i++) maps.push("-map", "0:a:0");

  const codecArgs: string[] = [];
  rungs.forEach((r, i) => {
    codecArgs.push(
      `-c:v:${i}`, "libx264",
      `-preset:v:${i}`, "veryfast",
      `-profile:v:${i}`, "high",
      `-b:v:${i}`, `${r.videoKbps}k`,
      // A ceiling and a matching buffer are what make the rung honest: without
      // them a complex passage overshoots the bitrate the master advertises and
      // the player that chose this rung on that number stalls.
      `-maxrate:v:${i}`, `${Math.round(r.videoKbps * 1.07)}k`,
      `-bufsize:v:${i}`, `${Math.round(r.videoKbps * 1.5)}k`,
      // Every rung must cut at the same instants or a player cannot switch
      // between them. Forcing IDR frames on the segment grid guarantees it
      // regardless of frame rate; disabling scene-cut keeps x264 from adding
      // keyframes that would let the muxer split somewhere else.
      `-force_key_frames:v:${i}`, `expr:gte(t,n_forced*${HLS_SEGMENT_SECONDS})`,
      `-x264-params:v:${i}`, "scenecut=0"
    );
  });

  const streamMap = rungs
    .map((r, i) => (withAudio ? `v:${i},a:${i},name:${r.name}` : `v:${i},name:${r.name}`))
    .join(" ");

  await runFfmpeg(
    handle,
    [
      "-y",
      "-i", source,
      "-filter_complex", [split, ...scales].join(";"),
      ...maps,
      ...codecArgs,
      ...(withAudio ? ["-c:a", "aac", "-b:a", `${AUDIO_KBPS}k`, "-ac", "2"] : []),
      "-pix_fmt", "yuv420p",
      "-f", "hls",
      "-hls_time", String(HLS_SEGMENT_SECONDS),
      "-hls_playlist_type", "vod",
      // Declares that every segment can be decoded without the one before it,
      // which is what lets a player join or switch rungs at any segment.
      "-hls_flags", "independent_segments",
      "-hls_segment_filename", path.join(outDir, "%v", "seg%05d.ts"),
      "-master_pl_name", "master.m3u8",
      "-var_stream_map", streamMap,
      path.join(outDir, "%v", "index.m3u8"),
    ],
    duration > 0 && onProgress
      ? (t) => onProgress(Math.min(1, t / Math.max(0.1, duration)))
      : undefined
  );

  // ffmpeg writes the master beside the variant dirs, naming each variant by
  // the same %v it used for the directory.
  const written = await readFile(path.join(outDir, "master.m3u8"), "utf8").catch(() => "");
  const variants = parseVariants(written);
  return variants.length > 0
    ? variants
    : // A build of ffmpeg that declined to write a master still produced usable
      // variants; describe them from the plan rather than losing the pass.
      rungs.map((r) => ({
        inf: `#EXT-X-STREAM-INF:BANDWIDTH=${(r.videoKbps + AUDIO_KBPS) * 1000},RESOLUTION=${r.width}x${r.height}`,
        uri: `${r.name}/index.m3u8`,
      }));
}

/** Write the merged master covering every variant published so far. */
export async function writeMaster(outDir: string, variants: Variant[]): Promise<void> {
  await writeFile(path.join(outDir, "master.m3u8"), masterPlaylist(variants), "utf8");
}

/** Every file under `dir`, relative to it — what the upload step walks. */
export async function listFiles(dir: string, base = ""): Promise<string[]> {
  const entries = await readdir(path.join(dir, base), { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const rel = base ? path.join(base, e.name) : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else out.push(rel);
  }
  return out;
}

/** Source geometry and duration for a rendered master, with sane fallbacks so a
 * failed probe still produces a usable single-rung ladder. */
export async function probeSource(
  file: string
): Promise<{ width: number; height: number; duration: number }> {
  const dims = await videoDimensions(file);
  return {
    width: dims?.width ?? 1920,
    height: dims?.height ?? 1080,
    duration: await mediaDuration(file),
  };
}

/** Duration in seconds via ffprobe; 0 when unknown. */
function mediaDuration(file: string): Promise<number> {
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
      const seconds = Number(out.trim());
      resolve(Number.isFinite(seconds) && seconds > 0 ? seconds : 0);
    });
    p.on("error", () => {
      clearTimeout(timer);
      resolve(0);
    });
  });
}
