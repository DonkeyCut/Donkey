#!/usr/bin/env bun
/**
 * Publish a template to the gallery, or take one down. Templates are assets in
 * Donkey's R2 bucket (see src/cut/server/cloud/templates.ts); nothing about
 * them lives in this repository.
 *
 *   bun run scripts/template-publish.ts publish "<project folder>" <meta.json> <render.mp4>
 *   bun run scripts/template-publish.ts remove <id>
 *
 * The project folder is a Mac library folder (project.json + media/). The
 * meta file holds the gallery entry the document cannot say:
 *   { "id", "name": { "en", … }, "description": { "en", … }, "category",
 *     "style", "fps" }
 * The render is the template exported; its first seconds become the card's
 * muted loop and its poster. Footage past 1080p or 8 Mbps ships re-encoded.
 *
 * Every environment reads the one bucket, so a publish is live on every
 * site that serves the gallery the moment the index lands.
 */

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { footageSlots } from "../src/cut/lib/templateFill";
import {
  TEMPLATE_ASPECTS,
  TEMPLATE_CATEGORIES,
  TEMPLATE_STYLES,
  type GalleryTemplate,
  type TemplateAspect,
  type TemplateIndex,
} from "../src/cut/lib/templateGallery";
import { timelineEnd } from "../src/cut/lib/timelineEnd";
import { isTextOverlay, type ProjectDoc, type StoredAsset } from "../src/cut/lib/types";
import { deletePrefix, getObject, putObject } from "../src/cut/server/cloud/r2";
import {
  TEMPLATE_INDEX_KEY,
  TEMPLATE_POSTER,
  TEMPLATE_PREVIEW,
  templateKey,
  templateMediaKey,
} from "../src/cut/server/cloud/templates";
import { contentTypeFor } from "../src/cut/server/serveFile";

// The card's loop: the render's opening seconds, small and silent.
const PREVIEW_SECONDS = 8;
const PREVIEW_LONG_EDGE = 720;
const POSTER_AT_S = 1;
// Footage ships light: video past this frame size or rate is re-encoded to it,
// at its own frame rate and timing, so a copy to a Mac or a browser stays a
// short download.
const FOOTAGE_LONG_EDGE = 1920;
const FOOTAGE_MAX_BPS = 8_000_000;
const FOOTAGE_RATE = "6M";
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

type Meta = Pick<GalleryTemplate, "id" | "name" | "description" | "category" | "style" | "fps">;

const [command, ...args] = process.argv.slice(2);

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
 * Templates ship silent: no soundtrack, every clip muted. An asset keeps only
 * its master file, the one file the gallery serves; a proxy or a separate
 * sound recording would name files that never publish. */
function galleryDoc(doc: ProjectDoc, meta: Meta): ProjectDoc {
  const edit: ProjectDoc = {
    ...doc,
    id: meta.id,
    name: meta.name.en,
    folderId: null,
    assets: doc.assets.filter((a) => a.type !== "audio").map(masterOnly),
    clips: doc.clips.map((c) => ({ ...c, muted: true })),
    audioClips: [],
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

/** The source seconds a file's clips play, widened by the handle, as the cut
 * to make: `from` sits just before a real frame, so that frame opens the
 * shorter file and every later one moves back by exactly `from`. Null when
 * nothing plays the file, or a matte is cut to its full length. */
function playedSpan(doc: ProjectDoc, assetId: string, file: string, src: Probe): { from: number; to: number } | null {
  const clips = doc.clips.filter((c) => c.assetId === assetId);
  const matted = clips.some((c) => c.removal?.matte || c.card?.matte);
  if (clips.length === 0 || matted) {
    return null;
  }
  const lo = Math.min(...clips.map((c) => c.in)) - FOOTAGE_HANDLE_S;
  const hi = Math.max(...clips.map((c) => c.out)) + FOOTAGE_HANDLE_S;
  const from = lo > 0 ? Math.max(0, frameBefore(file, lo) - FRAME_LEAD_S) : 0;
  return { from, to: Math.min(src.duration, hi) };
}

/** Move a trimmed source's clips and timings onto the shorter file: every
 * source second in the document drops by `from`. What the assistant once
 * watched or heard in the old file no longer lines up and is left behind. */
function shiftSource(doc: ProjectDoc, asset: StoredAsset, from: number, duration: number) {
  for (const clip of doc.clips) {
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
    // The gallery ships silent, so the sound stays behind.
    const out = path.join(tmp, asset.fileName);
    const edge = Math.min(FOOTAGE_LONG_EDGE, Math.max(src.width, src.height));
    const scale = `scale='if(gt(iw,ih),${edge},-2)':'if(gt(iw,ih),-2,${edge})'`;
    const cut = trim ? ["-ss", String(trim.from), "-t", String(trim.to - trim.from)] : [];
    execFileSync("ffmpeg", ["-v", "error", "-y", ...cut, "-i", file, "-map", "0:v:0", "-an", "-vf", scale,
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

async function publish(dir: string, metaPath: string, render: string) {
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

  // The card: a short muted loop scaled down, and its still.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "template-"));
  const sources = lightFootage(dir, doc, tmp);
  const preview = path.join(tmp, TEMPLATE_PREVIEW);
  const poster = path.join(tmp, TEMPLATE_POSTER);
  const scale = `scale='if(gt(iw,ih),${PREVIEW_LONG_EDGE},-2)':'if(gt(iw,ih),-2,${PREVIEW_LONG_EDGE})'`;
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", render, "-t", String(PREVIEW_SECONDS), "-an", "-vf", scale,
    "-c:v", "libx264", "-crf", "28", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart", preview]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(POSTER_AT_S), "-i", render, "-frames:v", "1", "-vf", scale,
    "-q:v", "3", poster]);

  // Media first, the index last, so the gallery never lists a template whose
  // bytes are still landing.
  for (const fileName of files) {
    const bytes = await fs.readFile(sources.get(fileName)!);
    await putObject(templateMediaKey(meta.id, fileName), bytes, contentTypeFor(fileName));
    console.log(`media  ${fileName}`);
  }
  await putObject(templateKey(meta.id, "project.json"), Buffer.from(JSON.stringify(doc)), "application/json");
  await putObject(templateKey(meta.id, TEMPLATE_PREVIEW), await fs.readFile(preview), "video/mp4");
  await putObject(templateKey(meta.id, TEMPLATE_POSTER), await fs.readFile(poster), "image/jpeg");
  await fs.rm(tmp, { recursive: true, force: true });

  const entry: GalleryTemplate = {
    ...meta,
    aspect,
    seconds: Math.round(timelineEnd(doc) * 10) / 10,
    slots: footageSlots(doc.clips, doc.assets).length,
    texts: doc.overlays.filter(isTextOverlay).length,
    version: String(Date.now()),
  };
  const index = await readIndex();
  const at = index.templates.findIndex((t) => t.id === meta.id);
  if (at >= 0) {
    index.templates[at] = entry;
  } else {
    index.templates.push(entry);
  }
  await writeIndex(index);
  console.log(`published ${meta.id} (${entry.seconds}s, ${entry.slots} slots, ${entry.texts} texts)`);
}

async function remove(id: string) {
  const index = await readIndex();
  await writeIndex({ templates: index.templates.filter((t) => t.id !== id) });
  const gone = await deletePrefix(templateKey(id, ""));
  console.log(`removed ${id} (${gone} objects)`);
}

if (command === "publish" && args.length === 3) {
  await publish(args[0], args[1], args[2]);
} else if (command === "remove" && args.length === 1) {
  await remove(args[0]);
} else {
  console.error("usage: template-publish.ts publish <project folder> <meta.json> <render.mp4> | remove <id>");
  process.exit(1);
}
process.exit(0);
