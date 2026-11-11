#!/usr/bin/env bun
/**
 * Publish a template to the gallery, or take one down. Templates are assets in
 * Donkey's R2 bucket (see src/cut/server/cloud/templates.ts); nothing about
 * them lives in this repository.
 *
 *   bun run scripts/template-publish.ts publish "<project folder>" <meta.json>
 *   bun run scripts/template-publish.ts remove <id>
 *   bun run scripts/template-publish.ts order <ids.json>
 *   bun run scripts/template-publish.ts frames <id>
 *   bun run scripts/template-publish.ts peaks <id>
 *   bun run scripts/template-publish.ts render "<project folder>" <meta.json> <out.mp4>
 *
 * The project folder is a Mac library folder (project.json + media/). The
 * meta file holds the gallery entry the document cannot say:
 *   { "id", "name": { "en", … }, "description": { "en", … }, "category",
 *     "style", "fps", "tags"? }
 * The gallery plays the template live, so nothing is rendered ahead but the
 * card's still: one frame of it, exported here through the same pipeline a
 * download takes. Footage past 1080p or 8 Mbps ships re-encoded. The gallery
 * lists templates in the index's order; `order` takes a JSON array of ids to
 * lead it, and the rest follow as they were. Each video clip's first frame
 * ships too, small, so the template page's timeline shows the clips without
 * decoding the footage; `frames` bakes them for a template already live. The
 * waveform peaks of every sound an audio clip plays ship the same way, and
 * `peaks` bakes them for a template already live. `render` exports a project
 * folder as the gallery would ship it, uploading nothing, to check it first.
 *
 * Every environment reads the one bucket, so a publish is live on every
 * site that serves the gallery the moment the index lands.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { headSrc } from "@donkeycut/effects-kit";
import { statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { footageSlots } from "../src/cut/lib/templateFill";
import {
  TEMPLATE_ASPECTS,
  TEMPLATE_CATEGORIES,
  TEMPLATE_SEARCH_ID,
  TEMPLATE_STYLES,
  type GalleryTemplate,
  type TemplateAspect,
  type TemplateIndex,
} from "../src/cut/lib/templateGallery";
import { timelineEnd } from "../src/cut/lib/timelineEnd";
import { peakBuckets } from "../src/cut/lib/waveform";
import { isTextOverlay, type ProjectDoc, type StoredAsset } from "../src/cut/lib/types";
import { buildDocExportSpec } from "../src/cut/lib/headless/docExport";
import { installHeadlessRuntime } from "../src/cut/lib/headless/runtime";
import { deletePrefix, getObject, putObject } from "../src/cut/server/cloud/r2";
import {
  TEMPLATE_FRAME_H,
  TEMPLATE_INDEX_KEY,
  TEMPLATE_PEAKS,
  TEMPLATE_POSTER,
  templateFrameKey,
  templateKey,
  templateMediaKey,
} from "../src/cut/server/cloud/templates";
import { runExport, type ExportSpec, type RenderHandle } from "../src/cut/server/exportPipeline";
import { contentTypeFor } from "../src/cut/server/serveFile";

// The card's still: of a few frames spread through the template, the one with
// the most going on, scaled down. A fade's black frame shows nothing, and the
// middle of a template usually has its picture and type on screen together.
// The template renders once and each candidate is a still cut from it.
const POSTER_LONG_EDGE = 720;
const POSTER_CANDIDATES = [0.2, 0.35, 0.5, 0.65, 0.8];
// The size a candidate is measured at, a small grey thumbnail.
const POSTER_PROBE_PX = 64;
const POSTER_PRESET = "tiktok";
// The headless session's media presign, which the poster's loopback answers.
const PRESIGN_GET = "/api/cut-cloud/media/presign-get";
const MEDIA_ROUTE = "/m/";
// Footage ships light: video past this frame size or rate is re-encoded to it,
// at its own frame rate and timing, so a copy to a Mac or a browser stays a
// short download.
const FOOTAGE_LONG_EDGE = 1920;
const FOOTAGE_MAX_BPS = 8_000_000;
const FOOTAGE_RATE = "6M";
// Sound an audio clip plays off footage is kept at this rate.
const FOOTAGE_AUDIO_RATE = "160k";
// A source keeps only the seconds its clips play, with room either side for
// a trim, once that saves at least a fifth of it.
const FOOTAGE_HANDLE_S = 1;
const FOOTAGE_TRIM_WORTH = 0.8;
// The cut starts this far ahead of the frame that opens it, so rounding in
// the seek never skips that frame; and the frame is looked for this far
// either side of the handle.
const FRAME_LEAD_S = 0.0005;
const FRAME_SEARCH_S = 1;
// A re-encode that moves the file's length by more than a frame would shift
// every cut in it; the publish stops instead.
const FOOTAGE_DRIFT_S = 0.05;
// Projects without an aspect are 9:16.
const DEFAULT_ASPECT = "9:16";
// Gallery ids are URL path segments.
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// What a project keeps for its maker, never for the people who start from it.
const MAKER_FIELDS = ["renders", "genvideo", "publish", "notes", "firstOpen", "ui", "kind"] as const;

type Meta = Pick<GalleryTemplate, "id" | "name" | "description" | "category" | "style" | "fps" | "tags">;

// Publishes on this machine take turns at the index: each holds this lock
// directory while it reads and writes the index, so two at once never drop
// each other's entry. A lock older than the stale age is a crashed holder's.
const INDEX_LOCK = path.join(os.tmpdir(), "donkey-template-index.lock");
const LOCK_POLL_MS = 200;
const LOCK_STALE_MS = 60_000;

const [command, ...args] = process.argv.slice(2);

/** Change the index under the lock: read it, let `change` return the new
 * one, write it. */
async function changeIndex(change: (index: TemplateIndex) => TemplateIndex) {
  for (;;) {
    try {
      await fs.mkdir(INDEX_LOCK);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }
    const held = await fs.stat(INDEX_LOCK).catch(() => null);
    if (held && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
      await fs.rm(INDEX_LOCK, { recursive: true, force: true });
      continue;
    }
    await Bun.sleep(LOCK_POLL_MS);
  }
  try {
    await writeIndex(change(await readIndex()));
  } finally {
    await fs.rm(INDEX_LOCK, { recursive: true, force: true });
  }
}

async function readIndex(): Promise<TemplateIndex> {
  const obj = await getObject(TEMPLATE_INDEX_KEY);
  return obj ? (JSON.parse(obj.bytes.toString("utf8")) as TemplateIndex) : { templates: [] };
}

async function writeIndex(index: TemplateIndex) {
  await putObject(TEMPLATE_INDEX_KEY, Buffer.from(JSON.stringify(index, null, 2)), "application/json");
}

/** The entry's fields the document cannot give, checked against the gallery's
 * vocabulary. */
function checkMeta(meta: Meta) {
  if (!ID_RE.test(meta.id)) {
    throw new Error(`id "${meta.id}" must be lowercase words joined by hyphens.`);
  }
  if (meta.id === TEMPLATE_SEARCH_ID) {
    throw new Error(`id "${meta.id}" is the gallery's search path.`);
  }
  if (!meta.name?.en || !meta.description?.en) {
    throw new Error("name.en and description.en are required.");
  }
  if (!TEMPLATE_CATEGORIES.includes(meta.category)) {
    throw new Error(`category is one of ${TEMPLATE_CATEGORIES.join(", ")}.`);
  }
  if (!TEMPLATE_STYLES.includes(meta.style)) {
    throw new Error(`style is one of ${TEMPLATE_STYLES.join(", ")}.`);
  }
  if (!(meta.fps > 0)) {
    throw new Error("fps is required.");
  }
  if (meta.tags !== undefined && !(Array.isArray(meta.tags) && meta.tags.every((t) => typeof t === "string" && t.trim()))) {
    throw new Error("tags, when given, is a list of keywords.");
  }
}

/** An asset with only its master file. */
function masterOnly(asset: StoredAsset): StoredAsset {
  const out = { ...asset };
  delete out.proxy;
  delete out.soundFrom;
  return out;
}

/** The document as the gallery serves it: the edit alone, with nothing of the
 * maker's own (renders, publishing notes, the opening layout) riding along.
 * Footage ships muted: the only sound is the template's own soundtrack, its
 * audio clips. An asset keeps only its master file, the one file the gallery
 * serves; a proxy or a separate sound recording would name files that never
 * publish. */
function galleryDoc(doc: ProjectDoc, meta: Meta): ProjectDoc {
  const edit: ProjectDoc = {
    ...doc,
    id: meta.id,
    name: meta.name.en,
    folderId: null,
    assets: doc.assets.map(masterOnly),
    clips: doc.clips.map((c) => ({ ...c, muted: true })),
    audioClips: doc.audioClips ?? [],
  };
  for (const key of MAKER_FIELDS) {
    delete edit[key];
  }
  return edit;
}

type Probe = { width: number; height: number; bitRate: number; duration: number };

/** The first video stream's frame size, its length, and the file's rate. The
 * length is the picture's own: a sound track that runs past it would make the
 * file look longer than the cuts read. */
function probe(file: string): Probe {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,duration:format=duration,bit_rate", "-of", "json", file], { encoding: "utf8" });
  const { streams, format } = JSON.parse(out) as {
    streams: { width: number; height: number; duration?: string }[];
    format: { duration: string; bit_rate: string };
  };
  const [video] = streams;
  return {
    width: video.width,
    height: video.height,
    bitRate: Number(format.bit_rate),
    duration: Number(video.duration ?? format.duration),
  };
}

/** The time of the last frame a file shows at or before `t`, read off the
 * file: a frame grid computed from the rate drifts off the real timestamps. */
function frameBefore(file: string, t: number): number {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-read_intervals",
    `${Math.max(0, t - FRAME_SEARCH_S)}%${t + FRAME_SEARCH_S}`, "-show_entries", "frame=best_effort_timestamp_time",
    "-of", "csv=p=0", file], { encoding: "utf8" });
  // A line may trail a comma: "12.012000,".
  const times = out.split("\n").map((line) => parseFloat(line)).filter((n) => Number.isFinite(n) && n <= t);
  return times.length > 0 ? Math.max(...times) : 0;
}

/** The source seconds a file's clips play or sound, widened by the handle, as
 * the cut to make: `from` sits just before a real frame, so that frame opens
 * the shorter file and every later one moves back by exactly `from`. Null
 * when nothing plays the file, or a matte is cut to its full length. */
function playedSpan(doc: ProjectDoc, assetId: string, file: string, src: Probe): { from: number; to: number } | null {
  const clips = doc.clips.filter((c) => c.assetId === assetId);
  const matted = clips.some((c) => c.removal?.matte || c.card?.matte);
  const spans = [...clips, ...doc.audioClips.filter((c) => c.assetId === assetId)];
  if (spans.length === 0 || matted) {
    return null;
  }
  const lo = Math.min(...spans.map((c) => c.in)) - FOOTAGE_HANDLE_S;
  const hi = Math.max(...spans.map((c) => c.out)) + FOOTAGE_HANDLE_S;
  const from = lo > 0 ? Math.max(0, frameBefore(file, lo) - FRAME_LEAD_S) : 0;
  return { from, to: Math.min(src.duration, hi) };
}

/** Move a trimmed source's clips and timings onto the shorter file: every
 * source second in the document drops by `from`. What the assistant once
 * watched or heard in the old file no longer lines up and is left behind. */
function shiftSource(doc: ProjectDoc, asset: StoredAsset, from: number, duration: number) {
  for (const clip of [...doc.clips, ...doc.audioClips]) {
    if (clip.assetId !== asset.id) {
      continue;
    }
    clip.in -= from;
    clip.out -= from;
    if (clip.speedCurve) {
      clip.speedCurve = clip.speedCurve.map(([t, rate]) => [t - from, rate]);
    }
  }
  asset.duration = duration;
  if (asset.sceneCuts) {
    asset.sceneCuts = asset.sceneCuts.map((t) => t - from).filter((t) => t > 0 && t < duration);
  }
  delete asset.watch;
  delete asset.speech;
  delete asset.beats;
}

/** Where each media file is read from: the project's own copy, or a lighter
 * re-encode in `tmp`. Footage past the gallery's size or rate is scaled down,
 * and a source its clips play only a part of is cut to that part. A matte is
 * read frame for frame against its source and ships untouched. The asset's
 * recorded size follows its file. */
function lightFootage(dir: string, doc: ProjectDoc, tmp: string): Map<string, string> {
  const sources = new Map<string, string>();
  const shared = new Set(doc.assets.map((a) => a.fileName).filter((f, i, all) => all.indexOf(f) !== i));
  for (const asset of doc.assets) {
    if (!asset.fileName || sources.has(asset.fileName)) {
      continue;
    }
    const file = path.join(dir, "media", asset.fileName);
    sources.set(asset.fileName, file);
    if (asset.type !== "video" || asset.origin === "matte") {
      continue;
    }
    const src = probe(file);
    const span = shared.has(asset.fileName) ? null : playedSpan(doc, asset.id, file, src);
    const trim = span && span.to - span.from < src.duration * FOOTAGE_TRIM_WORTH ? span : null;
    const heavy = Math.max(src.width, src.height) > FOOTAGE_LONG_EDGE || src.bitRate > FOOTAGE_MAX_BPS;
    if (!trim && !heavy) {
      continue;
    }

    // Long edge to 1080p at most, the frame rate and timestamps as they were.
    // Footage ships muted, so its sound stays behind unless an audio clip
    // plays it, e.g. sound detached from a clip onto its own track.
    const heard = doc.audioClips.some((c) => doc.assets.some((a) => a.id === c.assetId && a.fileName === asset.fileName));
    const sound = heard ? ["-map", "0:a:0?", "-c:a", "aac", "-b:a", FOOTAGE_AUDIO_RATE] : ["-an"];
    const out = path.join(tmp, asset.fileName);
    const edge = Math.min(FOOTAGE_LONG_EDGE, Math.max(src.width, src.height));
    const scale = `scale='if(gt(iw,ih),${edge},-2)':'if(gt(iw,ih),-2,${edge})'`;
    const cut = trim ? ["-ss", String(trim.from), "-t", String(trim.to - trim.from)] : [];
    execFileSync("ffmpeg", ["-v", "error", "-y", ...cut, "-i", file, "-map", "0:v:0", ...sound, "-vf", scale,
      "-fps_mode", "passthrough", "-c:v", "libx264", "-crf", "23", "-maxrate", FOOTAGE_RATE,
      "-bufsize", "12M", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
    const light = probe(out);
    const expected = trim ? trim.to - trim.from : src.duration;
    if (Math.abs(light.duration - expected) > FOOTAGE_DRIFT_S) {
      throw new Error(`${asset.fileName} re-encoded to ${light.duration}s, expected ${expected}s.`);
    }
    if (trim) {
      shiftSource(doc, asset, trim.from, light.duration);
    }
    sources.set(asset.fileName, out);
    console.log(`light  ${asset.fileName} ${src.width}x${src.height} ${src.duration.toFixed(1)}s -> ` +
      `${light.width}x${light.height} ${light.duration.toFixed(1)}s`);
  }

  // Every asset on a file records the file it now ships.
  for (const asset of doc.assets) {
    const out = sources.get(asset.fileName);
    if (!out || out.startsWith(path.join(dir, "media"))) {
      continue;
    }
    const light = probe(out);
    asset.width = light.width;
    asset.height = light.height;
    asset.sizeBytes = statSync(out).size;
  }
  return sources;
}

/** How much a picture shows: the spread of its brightness, measured on a
 * small grey copy. A flat frame, black or any one color, scores zero. */
function detailOf(file: string): number {
  const px = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-frames:v", "1",
    "-vf", `scale=${POSTER_PROBE_PX}:${POSTER_PROBE_PX},format=gray`, "-f", "rawvideo", "-"]);
  const mean = px.reduce((a, v) => a + v, 0) / px.length;
  return Math.sqrt(px.reduce((a, v) => a + (v - mean) ** 2, 0) / px.length);
}

/** The template exported through the headless doc export with media read
 * from `sources`, into `tmp`. The session points at a loopback that answers
 * the media presign with the local files. */
async function renderCut(doc: ProjectDoc, sources: Map<string, string>, tmp: string) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);

      // Every asked-for file maps to this server's media route.
      if (url.pathname === PRESIGN_GET && req.method === "POST") {
        const body = (await req.json()) as { items?: { fileName: string }[] };
        const urls = (body.items ?? []).map(({ fileName }) => ({
          fileName,
          url: `${server.url.origin}${MEDIA_ROUTE}${encodeURIComponent(fileName)}`,
        }));
        return Response.json({ urls });
      }

      // A media read: the file itself, ranges included.
      const file = url.pathname.startsWith(MEDIA_ROUTE)
        ? sources.get(decodeURIComponent(url.pathname.slice(MEDIA_ROUTE.length)))
        : undefined;
      return file ? new Response(Bun.file(file)) : new Response("Not found.", { status: 404 });
    },
  });
  try {
    await installHeadlessRuntime();
    const handle: RenderHandle = {
      tmpDir: path.join(tmp, "overlays"),
      outPath: path.join(tmp, "poster.mp4"),
      progress: 0,
      log: [],
    };
    await fs.mkdir(handle.tmpDir, { recursive: true });
    const session = { base: server.url.origin, headers: {} };
    const spec = (await buildDocExportSpec(session, doc.id!, POSTER_PRESET, handle.tmpDir, { doc, version: "1" })) as ExportSpec;
    await runExport(handle, spec, (file) => sources.get(path.basename(file))!);
    return { file: handle.outPath, duration: spec.duration };
  } finally {
    server.stop(true);
  }
}

// A `render` keeps its cut in the project folder, beside the key of what it
// rendered, so the publish that follows takes its still from it.
const KEPT_CUT = ".render.mp4";
const KEPT_KEY = ".render.key";

/** What the picture of a render of `doc` from `dir` depends on: the document
 * and the size and age of every file it shows. The still is a picture, so the
 * sound is left out, and a soundtrack added after the render keeps it. */
function cutKey(dir: string, doc: ProjectDoc): string {
  const assets = doc.assets.filter((a) => a.type !== "audio");
  const hash = createHash("sha256").update(JSON.stringify({ ...doc, assets, audioClips: [] }));
  for (const fileName of [...new Set(assets.map((a) => a.fileName).filter(Boolean))].sort()) {
    const stat = statSync(path.join(dir, "media", fileName!));
    hash.update(`${fileName}:${stat.size}:${stat.mtimeMs}`);
  }
  return hash.digest("hex");
}

/** The cut a `render` kept for exactly this document and media, if any. */
async function keptCut(dir: string, doc: ProjectDoc) {
  const key = await fs.readFile(path.join(dir, KEPT_KEY), "utf8").catch(() => "");
  if (key !== cutKey(dir, doc)) {
    return null;
  }
  const file = path.join(dir, KEPT_CUT);
  if (!(await fs.stat(file).catch(() => null))) {
    return null;
  }
  return { file, duration: probe(file).duration };
}

/** The card's still: of the candidate frames cut from one render, the one
 * with the most detail. A cut kept by `render` for the same document serves
 * as that render. */
async function renderPoster(dir: string, doc: ProjectDoc, sources: Map<string, string>, tmp: string, out: string) {
  const cut = (await keptCut(dir, doc)) ?? (await renderCut(doc, sources, tmp));
  const scale = `scale='if(gt(iw,ih),${POSTER_LONG_EDGE},-2)':'if(gt(iw,ih),-2,${POSTER_LONG_EDGE})'`;
  let best = { detail: -1, file: "" };
  for (const [i, share] of POSTER_CANDIDATES.entries()) {
    const still = path.join(tmp, `poster-${i}.jpg`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(cut.duration * share), "-i", cut.file,
      "-frames:v", "1", "-vf", scale, "-q:v", "3", still]);
    const detail = detailOf(still);
    if (detail > best.detail) {
      best = { detail, file: still };
    }
  }
  await fs.copyFile(best.file, out);
}

// How far before a source's end a frame is read when the clip starts past it.
const FRAME_TAIL_S = 0.1;

/** Each video clip's first frame, read from the footage as it ships and
 * stored small beside the template. */
async function bakeFrames(id: string, doc: ProjectDoc, sources: Map<string, string>, tmp: string) {
  let count = 0;
  for (const clip of doc.clips) {
    const asset = doc.assets.find((a) => a.id === clip.assetId);
    if (asset?.type !== "video" || asset.block) {
      continue;
    }

    // The template page draws every footage clip from its frame, so a clip
    // without footage to read stops the publish.
    const file = asset.fileName ? sources.get(asset.fileName) : undefined;
    if (!file) {
      throw new Error(`${id}: clip ${clip.id} has no footage to bake a frame from.`);
    }
    const at = Math.max(0, Math.min(headSrc(clip), probe(file).duration - FRAME_TAIL_S));
    const out = path.join(tmp, `frame-${clip.id}.jpg`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(at), "-i", file, "-frames:v", "1",
      "-vf", `scale=-2:${TEMPLATE_FRAME_H}`, "-q:v", "4", out]);
    await putObject(templateFrameKey(id, clip.id), await fs.readFile(out), "image/jpeg");
    count++;
  }
  console.log(`frames ${count}`);
}

// Peaks keep this many decimals; the strip draws a few dozen pixels tall.
const PEAK_DECIMALS = 3;
// The decoded sound of one source is read whole into memory.
const PEAK_READ_BYTES = 1 << 30;
const F32_BYTES = 4;

/** The loudest sample of the first channel in each of `buckets` equal slices
 * of `file`, measured the way the editor measures a waveform. */
function peaksOf(file: string, buckets: number): number[] {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a:0", "-af", "pan=mono|c0=c0",
    "-f", "f32le", "-"], { maxBuffer: PEAK_READ_BYTES });
  const samples = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / F32_BYTES));
  const peaks = new Array<number>(buckets).fill(0);
  for (let i = 0; i < samples.length; i++) {
    const at = Math.min(buckets - 1, Math.floor((i / samples.length) * buckets));
    const v = Math.abs(samples[i]);
    if (v > peaks[at]) {
      peaks[at] = v;
    }
  }
  const scale = 10 ** PEAK_DECIMALS;
  return peaks.map((v) => Math.round(Math.min(1, v) * scale) / scale);
}

/** The waveform of every asset an audio clip plays, keyed by asset id, read
 * from the media as it ships and stored beside the template. */
async function bakePeaks(id: string, doc: ProjectDoc, sources: Map<string, string>) {
  const heard = new Set(doc.audioClips.map((c) => c.assetId));
  const baked: Record<string, number[]> = {};
  for (const asset of doc.assets) {
    if (!heard.has(asset.id)) {
      continue;
    }
    const file = asset.fileName ? sources.get(asset.fileName) : undefined;
    if (!file) {
      throw new Error(`${id}: asset ${asset.id} has no sound to bake peaks from.`);
    }
    baked[asset.id] = peaksOf(file, peakBuckets(asset.duration));
  }
  await putObject(templateKey(id, TEMPLATE_PEAKS), Buffer.from(JSON.stringify(baked)), "application/json");
  console.log(`peaks  ${Object.keys(baked).length}`);
}

/** A published template's stored document, with the files of the assets
 * `keep` picks downloaded into a temp folder. */
async function storedTemplate(id: string, keep: (asset: StoredAsset, doc: ProjectDoc) => boolean) {
  const stored = await getObject(templateKey(id, "project.json"));
  if (!stored) {
    throw new Error(`${id} is not published.`);
  }
  const doc = JSON.parse(stored.bytes.toString("utf8")) as ProjectDoc;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "template-bake-"));
  const sources = new Map<string, string>();
  for (const asset of doc.assets) {
    if (!keep(asset, doc) || !asset.fileName || sources.has(asset.fileName)) {
      continue;
    }
    const media = await getObject(templateMediaKey(id, asset.fileName));
    if (!media) {
      throw new Error(`${id} is missing ${asset.fileName}.`);
    }
    const file = path.join(tmp, asset.fileName);
    await fs.writeFile(file, media.bytes);
    sources.set(asset.fileName, file);
  }
  return { doc, sources, tmp };
}

/** Bake the clip frames of a template already published, from its stored
 * document and media. */
async function frames(id: string) {
  const { doc, sources, tmp } = await storedTemplate(id, (a) => a.type === "video");
  await bakeFrames(id, doc, sources, tmp);
  await fs.rm(tmp, { recursive: true, force: true });
}

/** Bake the waveform peaks of a template already published, from its stored
 * document and media. */
async function peaks(id: string) {
  const { doc, sources, tmp } = await storedTemplate(id, (a, doc) => doc.audioClips.some((c) => c.assetId === a.id));
  await bakePeaks(id, doc, sources);
  await fs.rm(tmp, { recursive: true, force: true });
}

/** Export a project folder as the gallery would ship it to `out`, uploading
 * nothing: the check before a publish. */
async function render(dir: string, metaPath: string, out: string) {
  const meta = JSON.parse(await fs.readFile(metaPath, "utf8")) as Meta;
  const source = JSON.parse(await fs.readFile(path.join(dir, "project.json"), "utf8")) as ProjectDoc;
  const doc = galleryDoc(source, meta);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "template-render-"));
  try {
    const cut = await renderCut(doc, lightFootage(dir, doc, tmp), tmp);
    await fs.copyFile(cut.file, out);
    await fs.copyFile(cut.file, path.join(dir, KEPT_CUT));
    await fs.writeFile(path.join(dir, KEPT_KEY), cutKey(dir, doc));
    console.log(`rendered ${meta.id} (${cut.duration.toFixed(1)}s) to ${out}`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function publish(dir: string, metaPath: string) {
  const meta = JSON.parse(await fs.readFile(metaPath, "utf8")) as Meta;
  checkMeta(meta);
  const source = JSON.parse(await fs.readFile(path.join(dir, "project.json"), "utf8")) as ProjectDoc;
  // The frame shape is the project's own; the gallery offers only its shapes.
  const aspect = (source.aspect ?? DEFAULT_ASPECT) as TemplateAspect;
  if (!TEMPLATE_ASPECTS.includes(aspect)) {
    throw new Error(`The project is ${aspect}; the gallery takes ${TEMPLATE_ASPECTS.join(", ")}.`);
  }
  const doc = galleryDoc(source, meta);

  // Every file the document names; a block asset has none.
  const files = [...new Set(doc.assets.map((a) => a.fileName).filter(Boolean))];
  for (const fileName of files) {
    await fs.access(path.join(dir, "media", fileName));
  }

  // The footage as it ships, and the card's still rendered from it.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "template-"));
  // The temp folder goes whether the publish lands or fails.
  try {
    const sources = lightFootage(dir, doc, tmp);
    await bakeFrames(meta.id, doc, sources, tmp);
    await bakePeaks(meta.id, doc, sources);
    const poster = path.join(tmp, TEMPLATE_POSTER);
    await renderPoster(dir, doc, sources, tmp, poster);

    // Media first, the index last, so the gallery never lists a template whose
    // bytes are still landing.
    for (const fileName of files) {
      const bytes = await fs.readFile(sources.get(fileName)!);
      await putObject(templateMediaKey(meta.id, fileName), bytes, contentTypeFor(fileName));
      console.log(`media  ${fileName}`);
    }
    await putObject(templateKey(meta.id, "project.json"), Buffer.from(JSON.stringify(doc)), "application/json");
    await putObject(templateKey(meta.id, TEMPLATE_POSTER), await fs.readFile(poster), "image/jpeg");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }

  const entry: GalleryTemplate = {
    ...meta,
    aspect,
    seconds: Math.round(timelineEnd(doc) * 10) / 10,
    slots: footageSlots(doc.clips, doc.assets).length,
    texts: doc.overlays.filter(isTextOverlay).length,
    music: doc.audioClips.length > 0,
    version: String(Date.now()),
  };
  await changeIndex((index) => {
    const at = index.templates.findIndex((t) => t.id === meta.id);
    if (at >= 0) {
      index.templates[at] = entry;
    } else {
      index.templates.push(entry);
    }
    return index;
  });

  // The kept cut has served its still; it goes once the template is live.
  await fs.rm(path.join(dir, KEPT_CUT), { force: true });
  await fs.rm(path.join(dir, KEPT_KEY), { force: true });
  console.log(`published ${meta.id} (${entry.seconds}s, ${entry.slots} slots, ${entry.texts} texts)`);
}

async function remove(id: string) {
  await changeIndex((index) => ({ templates: index.templates.filter((t) => t.id !== id) }));
  const gone = await deletePrefix(templateKey(id, ""));
  console.log(`removed ${id} (${gone} objects)`);
}

/** Put the templates `file` lists (a JSON array of ids) first in the
 * gallery, in its order; the rest keep theirs behind them. */
async function order(file: string) {
  const ids = JSON.parse(await fs.readFile(file, "utf8")) as string[];
  let total = 0;
  await changeIndex((index) => {
    const byId = new Map(index.templates.map((t) => [t.id, t]));
    const unknown = ids.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      throw new Error(`not in the gallery: ${unknown.join(", ")}`);
    }
    const lead = new Set(ids);
    const templates = [...ids.map((id) => byId.get(id)!), ...index.templates.filter((t) => !lead.has(t.id))];
    total = templates.length;
    return { templates };
  });
  console.log(`ordered ${ids.length} of ${total} templates`);
}

if (command === "publish" && args.length === 2) {
  await publish(args[0], args[1]);
} else if (command === "remove" && args.length === 1) {
  await remove(args[0]);
} else if (command === "order" && args.length === 1) {
  await order(args[0]);
} else if (command === "frames" && args.length === 1) {
  await frames(args[0]);
} else if (command === "peaks" && args.length === 1) {
  await peaks(args[0]);
} else if (command === "render" && args.length === 3) {
  await render(args[0], args[1], args[2]);
} else {
  console.error("usage: template-publish.ts publish <project folder> <meta.json> | remove <id> | order <ids.json> | frames <id> | peaks <id> | render <project folder> <meta.json> <out.mp4>");
  process.exit(1);
}
process.exit(0);
