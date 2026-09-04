import { spawn } from "node:child_process";
import { copyFile, constants, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ClipSound } from "@donkeycut/effects-kit";
import { resolveParent, settleParents } from "@/cut/lib/folderTree";
import { cutDataRoot } from "./dataDir";
import { assertLocalRuntime } from "./local-only";
import { mediaPath as projectMediaPath, readProject } from "./projects";
import { exists, uniqueName, writeJsonAtomic } from "./util";

/** The Mac's library: reusable media that lives outside any project, shared by
 * every account that signs in on this Mac. */
const libraryRoot = () => path.join(cutDataRoot(), "library");
const libMedia = () => path.join(libraryRoot(), "media");
const indexPath = () => path.join(libraryRoot(), "library.json");

/** Where a URL-imported asset came from, kept as notes on the asset. */
export interface LibrarySource {
  url: string;
  title?: string;
  uploader?: string;
  uploadDate?: string; // yt-dlp YYYYMMDD
}

export interface LibraryAsset {
  id: string;
  fileName: string;
  name: string;
  type: "video" | "audio" | "image" | "font";
  duration: number;
  width?: number;
  height?: number;
  addedAt: number;
  folderId?: string | null;
  source?: LibrarySource;
  /** The source's own cover image, stored beside the media and served by the
   * same media route — what a card and the viewer show while the video loads.
   * Only an import from a site that publishes one has it. */
  posterFile?: string;
  /** How the asset entered the account from the iOS app: a phone camera
   * recording (the desktop's Camera Roll) or an inspiration item. Cloud shelf
   * only. */
  origin?: "camera" | "inspiration";
}

export interface LibraryFolder {
  id: string;
  name: string;
  /** The folder this one is filed in; null (or absent, from before nesting)
   * is the top level. */
  parentId?: string | null;
  createdAt: number;
}

/**
 * A saved timeline selection kept *by reference*: the source media plus the
 * edit that arranges it (trims, layout regions, overlays, captions), never a
 * flattened video. Re-adding it copies the media into the project and
 * re-materializes editable clips. Its media files live privately in the library
 * (not as loose assets), so a template stays whole even if the project it came
 * from is deleted. `layers`/`audio` reference `media` by array index.
 */
export interface TemplateMedia {
  fileName: string; // private copy inside the library media folder
  name: string;
  type: "video" | "audio" | "image";
  duration: number;
  width?: number;
  height?: number;
}
export interface TemplateLayer {
  media: number; // index into template.media
  start: number;
  in: number;
  out: number;
  frame?: { x: number; y: number; w: number; h: number };
  fit?: "fit" | "fill";
  /** The picture's own framing inside that box: zoom, crop pan, turn, fade. */
  zoom?: number;
  panX?: number;
  panY?: number;
  rotation?: number;
  opacity?: number;
  muted: boolean;
  speed?: number;
  speedCurve?: [number, number][];
  reverse?: boolean;
  sound?: ClipSound;
  track: number;
  asClip?: boolean; // re-materializes as a track-0 timeline clip rather than an overlay
}
export interface TemplateAudio {
  media: number;
  start: number;
  in: number;
  out: number;
  volume: number;
  fadeIn?: number;
  fadeOut?: number;
  speed?: number;
  speedCurve?: [number, number][];
  reverse?: boolean;
  sound?: ClipSound;
}
export interface LibraryTemplate {
  id: string;
  name: string;
  addedAt: number;
  folderId?: string | null;
  duration: number;
  media: TemplateMedia[];
  layers: TemplateLayer[];
  audio: TemplateAudio[];
  texts: unknown[]; // opaque TextOverlay[] round-tripped for the client
  cues: unknown[]; // opaque SubtitleCue[]
  /** A template carrying only this is a saved sound preset. */
  sound?: ClipSound;
}

interface LibraryIndex {
  assets: LibraryAsset[];
  folders?: LibraryFolder[];
  templates?: LibraryTemplate[];
}

export function libMediaPath(fileName: string) {
  assertLocalRuntime();
  const safe = path.basename(fileName);
  if (!safe || safe.startsWith(".")) throw new Error("Invalid file name.");
  return path.join(libMedia(), safe);
}

async function readIndex(): Promise<LibraryIndex> {
  assertLocalRuntime();
  let raw: string;
  try {
    raw = await readFile(indexPath(), "utf8");
  } catch {
    return { assets: [] };
  }
  try {
    return JSON.parse(raw) as LibraryIndex;
  } catch (err) {
    console.error(`Corrupt library index ${indexPath()}:`, err);
  }
  try {
    const idx = JSON.parse(
      await readFile(`${indexPath()}.bak`, "utf8"),
    ) as LibraryIndex;
    await writeIndex(idx);
    return idx;
  } catch (err) {
    console.error(`Could not recover ${indexPath()} from backup:`, err);
    return { assets: [] };
  }
}

async function writeIndex(idx: LibraryIndex) {
  assertLocalRuntime();
  await mkdir(libMedia(), { recursive: true });
  await writeJsonAtomic(indexPath(), idx);
}

// Serialize read-modify-write cycles on the shared index. Without this, moving
// several assets at once (concurrent requests) would each read the index, change
// one asset, and write the whole file back — clobbering each other's changes.
// Each mutation reads the freshly-written state, applies its change, and writes.
let indexLock: Promise<unknown> = Promise.resolve();
async function mutateIndex<T>(
  fn: (idx: LibraryIndex) => T | Promise<T>,
): Promise<T> {
  const run = indexLock.then(async () => {
    const idx = await readIndex();
    const result = await fn(idx);
    await writeIndex(idx);
    return result;
  });
  indexLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function listLibrary(): Promise<LibraryAsset[]> {
  const idx = await readIndex();
  return idx.assets.sort((a, b) => b.addedAt - a.addedAt);
}

const VIDEO_RE = /\.(mp4|mov|m4v|webm|mkv)$/i;
const AUDIO_RE = /\.(mp3|m4a|aac|wav|ogg|flac)$/i;
const IMAGE_RE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;
const FONT_RE = /\.(ttf|otf|woff2?)$/i;

function ffprobe(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffprobe", ["-v", "error", ...args]);
    const timer = setTimeout(() => p.kill("SIGKILL"), 30_000);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error("Could not read this media file."));
    });
  });
}

async function probe(filePath: string) {
  const duration = parseFloat(
    await ffprobe([
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      filePath,
    ]),
  );
  let width: number | undefined;
  let height: number | undefined;
  if (VIDEO_RE.test(filePath) || IMAGE_RE.test(filePath)) {
    const dims = await ffprobe([
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0",
      filePath,
    ]).catch(() => "");
    const [w, h] = dims.split(",").map(Number);
    if (w && h) {
      width = w;
      height = h;
    }
  }
  // An image has no timeline duration of its own.
  return { duration: Number.isFinite(duration) ? duration : 0, width, height };
}

async function freeName(original: string) {
  const base = path
    .basename(original)
    .replace(/[^\w.\-() ]+/g, "_")
    .slice(-80);
  return uniqueName(base, libMediaPath);
}

function typeOf(fileName: string): "video" | "audio" | "image" | "font" | null {
  if (VIDEO_RE.test(fileName)) return "video";
  if (AUDIO_RE.test(fileName)) return "audio";
  if (IMAGE_RE.test(fileName)) return "image";
  if (FONT_RE.test(fileName)) return "font";
  return null;
}

export async function register(
  fileName: string,
  name: string,
  source?: LibrarySource,
  posterFile?: string,
): Promise<LibraryAsset> {
  const type = typeOf(fileName);
  if (!type) throw new Error("Unsupported file type.");
  const meta: { duration: number; width?: number; height?: number } =
    type === "font" ? { duration: 0 } : await probe(libMediaPath(fileName));
  const asset: LibraryAsset = {
    id: crypto.randomUUID().slice(0, 8),
    fileName,
    name,
    type,
    duration: meta.duration,
    ...(meta.width ? { width: meta.width, height: meta.height } : {}),
    addedAt: Date.now(),
    folderId: null,
    ...(source ? { source } : {}),
    ...(posterFile ? { posterFile } : {}),
  };
  await mutateIndex((idx) => {
    idx.assets.push(asset);
  });
  return asset;
}

/** Upload a file straight into the library. */
export async function addUpload(
  file: File,
  name?: string,
  source?: LibrarySource,
  poster?: File,
): Promise<LibraryAsset> {
  if (!typeOf(file.name)) throw new Error("Unsupported file type.");
  await mkdir(libMedia(), { recursive: true });
  const fileName = await freeName(file.name);
  await writeFile(
    libMediaPath(fileName),
    Buffer.from(await file.arrayBuffer()),
  );
  // An import that came down from elsewhere brings the source's cover with it;
  // it is stored like any other library file, named after the media it belongs
  // to, and taken down with it.
  let posterFile: string | undefined;
  if (poster) {
    posterFile = `${fileName}.poster${path.extname(poster.name) || ".jpg"}`;
    await writeFile(
      libMediaPath(posterFile),
      Buffer.from(await poster.arrayBuffer()),
    );
  }
  return register(fileName, name?.trim() || file.name, source, posterFile);
}

/** Copy a project's media file into the library for reuse. */
export async function addFromProject(
  projectId: string,
  fileName: string,
  name: string,
): Promise<LibraryAsset> {
  const src = projectMediaPath(projectId, fileName);
  if (!(await exists(src))) throw new Error("Media file not found in project.");
  await mkdir(libMedia(), { recursive: true });
  const dest = await freeName(fileName);
  await copyFile(src, libMediaPath(dest));
  return register(dest, name || fileName);
}

/** Move a freshly downloaded file into the library and register it, with the
 * source's cover image beside it when the download brought one back. */
export async function addDownloaded(
  srcPath: string,
  name: string,
  source?: LibrarySource,
  posterPath?: string,
): Promise<LibraryAsset> {
  if (!typeOf(srcPath)) throw new Error("Unsupported file type.");
  await mkdir(libMedia(), { recursive: true });
  const dest = await freeName(path.basename(srcPath));
  await copyFile(srcPath, libMediaPath(dest));
  let posterFile: string | undefined;
  if (posterPath) {
    posterFile = await freeName(`${dest}.poster${path.extname(posterPath)}`);
    await copyFile(posterPath, libMediaPath(posterFile)).catch(() => {
      posterFile = undefined;
    });
  }
  return register(dest, name || path.basename(srcPath), source, posterFile);
}

/** Copy a library asset into a project's media folder. Returns the file name
 * inside the project. */
export async function useInProject(
  assetId: string,
  projectId: string,
): Promise<string> {
  const idx = await readIndex();
  const asset = idx.assets.find((a) => a.id === assetId);
  if (!asset) throw new Error("Library asset not found.");
  if (!(await readProject(projectId))) throw new Error("Project not found.");

  const base = asset.fileName;
  const dest = await uniqueName(base, (n) => projectMediaPath(projectId, n));
  // A clone where the disk offers one: the project's file shares the
  // shelf's blocks until either is written, so landing a multi-gigabyte
  // recording is a metadata write, and the page reading the project's copy
  // a moment later is not waiting behind the bytes.
  await copyFile(libMediaPath(base), projectMediaPath(projectId, dest), constants.COPYFILE_FICLONE);
  return dest;
}

export async function removeAsset(id: string) {
  const { fileName, posterFile } = await mutateIndex((idx) => {
    const asset = idx.assets.find((a) => a.id === id);
    if (!asset) throw new Error("Library asset not found.");
    idx.assets = idx.assets.filter((a) => a.id !== id);
    return { fileName: asset.fileName, posterFile: asset.posterFile };
  });
  await rm(libMediaPath(fileName), { force: true });
  if (posterFile) await rm(libMediaPath(posterFile), { force: true });
}

export function getAsset(id: string) {
  return readIndex().then((idx) => idx.assets.find((a) => a.id === id));
}

// --- Folders: named groups that file into each other; assets carry a
// folderId, folders a parentId. ---

export async function listFolders(): Promise<LibraryFolder[]> {
  const idx = await readIndex();
  return settleParents(idx.folders ?? []).sort((a, b) => a.createdAt - b.createdAt);
}

export async function createFolder(
  name: string,
  parentId: string | null = null,
): Promise<LibraryFolder> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Folder name required.");
  const id = crypto.randomUUID().slice(0, 8);
  return mutateIndex((idx) => {
    const folder: LibraryFolder = {
      id,
      name: trimmed.slice(0, 80),
      parentId: resolveParent(idx.folders ?? [], id, parentId),
      createdAt: Date.now(),
    };
    idx.folders = [...(idx.folders ?? []), folder];
    return folder;
  });
}

/** Rename a folder, file it under another (null for the top level), or
 * both; a key left undefined keeps what the folder has. */
export async function updateFolder(
  id: string,
  patch: { name?: string; parentId?: string | null },
): Promise<LibraryFolder> {
  const trimmed = patch.name?.trim();
  if (patch.name !== undefined && !trimmed) throw new Error("Folder name required.");
  return mutateIndex((idx) => {
    const folder = (idx.folders ?? []).find((f) => f.id === id);
    if (!folder) throw new Error("Folder not found.");
    if (trimmed) folder.name = trimmed.slice(0, 80);
    if (patch.parentId !== undefined) {
      folder.parentId = resolveParent(idx.folders ?? [], id, patch.parentId);
    }
    return folder;
  });
}

/** Delete a folder. What it held — its items and the folders inside it —
 * comes up one level, filed where the folder was. */
export async function deleteFolder(id: string) {
  await mutateIndex((idx) => {
    const gone = (idx.folders ?? []).find((f) => f.id === id);
    if (!gone) return;
    const up = gone.parentId ?? null;
    idx.folders = (idx.folders ?? []).filter((f) => f.id !== id);
    for (const f of idx.folders) if ((f.parentId ?? null) === id) f.parentId = up;
    for (const a of idx.assets) if (a.folderId === id) a.folderId = up;
    for (const t of idx.templates ?? [])
      if (t.folderId === id) t.folderId = up;
  });
}

/** File a library item — an asset or a template — into a folder (`null` ungroups). */
export async function moveItem(id: string, folderId: string | null) {
  await mutateIndex((idx) => {
    const item =
      idx.assets.find((a) => a.id === id) ??
      (idx.templates ?? []).find((t) => t.id === id);
    if (!item) throw new Error("Library item not found.");
    if (folderId && !(idx.folders ?? []).some((f) => f.id === folderId)) {
      throw new Error("Folder not found.");
    }
    item.folderId = folderId;
  });
}

// --- Templates: reusable selections saved by reference (see LibraryTemplate). ---

/** What the client sends to save a selection: source media (project files) plus
 * the edit that arranges them, referencing media by array index. */
export interface TemplateInput {
  name: string;
  duration: number;
  media: {
    fileName: string;
    name: string;
    type: "video" | "audio" | "image";
    duration: number;
    width?: number;
    height?: number;
  }[];
  layers: TemplateLayer[];
  audio: TemplateAudio[];
  texts: unknown[];
  cues: unknown[];
  sound?: LibraryTemplate["sound"];
}

/** A template with nothing on it saves nothing; a sound preset is a template
 * carrying only its treatment. */
const templateEmpty = (input: TemplateInput) =>
  !input.media?.length && !input.texts?.length && !input.cues?.length && !input.sound;

export async function listTemplates(): Promise<LibraryTemplate[]> {
  const idx = await readIndex();
  return (idx.templates ?? []).slice().sort((a, b) => b.addedAt - a.addedAt);
}

/** Save a selection as a template: copy each source into the library privately
 * and store the edit that references it. */
/**
 * Land a template that came off another shelf.
 *
 * A template's media live privately in the library, so carrying one here means
 * taking its files as they arrive and keeping the doc's own order: `layers` and
 * `audio` point at `media` by index, and only the file names change.
 */
export async function importTemplate(
  input: TemplateInput & { folderId?: string | null },
  files: File[],
): Promise<LibraryTemplate> {
  if (templateEmpty(input)) throw new Error("Nothing to add.");
  await mkdir(libMedia(), { recursive: true });
  const media: TemplateMedia[] = [];
  for (const [i, m] of (input.media ?? []).entries()) {
    const file = files[i];
    if (!file) throw new Error("Template media missing.");
    const dest = await freeName(m.fileName || file.name);
    await writeFile(libMediaPath(dest), Buffer.from(await file.arrayBuffer()));
    media.push({ ...m, fileName: dest });
  }
  const template: LibraryTemplate = {
    id: crypto.randomUUID().slice(0, 8),
    name: (input.name || "Template").trim().slice(0, 80),
    addedAt: Date.now(),
    duration: input.duration,
    media,
    layers: input.layers ?? [],
    audio: input.audio ?? [],
    texts: input.texts ?? [],
    cues: input.cues ?? [],
    ...(input.sound ? { sound: input.sound } : {}),
    folderId: input.folderId ?? null,
  };
  await mutateIndex((idx) => {
    idx.templates = [...(idx.templates ?? []), template];
  });
  return template;
}

export async function saveTemplate(
  projectId: string,
  input: TemplateInput,
): Promise<LibraryTemplate> {
  if (!(await readProject(projectId))) throw new Error("Project not found.");
  if (templateEmpty(input)) throw new Error("Nothing to save.");
  await mkdir(libMedia(), { recursive: true });
  const media: TemplateMedia[] = [];
  for (const m of input.media) {
    const src = projectMediaPath(projectId, m.fileName);
    if (!(await exists(src)))
      throw new Error("Media file not found in project.");
    const dest = await freeName(m.fileName);
    await copyFile(src, libMediaPath(dest));
    media.push({
      fileName: dest,
      name: m.name,
      type: m.type,
      duration: m.duration,
      width: m.width,
      height: m.height,
    });
  }
  const template: LibraryTemplate = {
    id: crypto.randomUUID().slice(0, 8),
    name: (input.name || "Template").trim().slice(0, 80),
    addedAt: Date.now(),
    duration: input.duration,
    media,
    layers: input.layers ?? [],
    audio: input.audio ?? [],
    texts: input.texts ?? [],
    cues: input.cues ?? [],
    ...(input.sound ? { sound: input.sound } : {}),
  };
  await mutateIndex((idx) => {
    idx.templates = [...(idx.templates ?? []), template];
  });
  return template;
}

/** Materialize a template into a project: copy its media in and hand the client
 * the project file names (in template media order) plus the stored edit. */
export async function useTemplate(templateId: string, projectId: string) {
  if (!(await readProject(projectId))) throw new Error("Project not found.");
  const idx = await readIndex();
  const template = (idx.templates ?? []).find((x) => x.id === templateId);
  if (!template) throw new Error("Template not found.");
  const media: TemplateMedia[] = [];
  for (const m of template.media) {
    const dest = await uniqueName(m.fileName, (n) =>
      projectMediaPath(projectId, n),
    );
    await copyFile(libMediaPath(m.fileName), projectMediaPath(projectId, dest));
    media.push({ ...m, fileName: dest });
  }
  return { template, media };
}

/** Append one project media file to a template as a part at its end: the file
 * is copied into the library (templates own their media privately) and the
 * given layer/audio shape lands re-pointed at the new media entry, starting at
 * the template's current end. `extend` grows the stored duration. */
export async function addMediaToTemplate(
  templateId: string,
  projectId: string,
  input: {
    media: Omit<TemplateMedia, "fileName"> & { fileName: string };
    layer?: Omit<TemplateLayer, "media" | "start">;
    audio?: Omit<TemplateAudio, "media" | "start">;
    extend: number;
  },
): Promise<LibraryTemplate> {
  const src = projectMediaPath(projectId, input.media.fileName);
  if (!(await exists(src))) throw new Error("Media file not found in project.");
  await mkdir(libMedia(), { recursive: true });
  const dest = await freeName(input.media.fileName);
  await copyFile(src, libMediaPath(dest));
  try {
    return await mutateIndex((idx) => {
      const t = (idx.templates ?? []).find((x) => x.id === templateId);
      if (!t) throw new Error("Template not found.");
      const mi = t.media.length;
      t.media = [...t.media, { ...input.media, fileName: dest }];
      if (input.audio)
        t.audio = [
          ...t.audio,
          { ...input.audio, media: mi, start: t.duration },
        ];
      else if (input.layer)
        t.layers = [
          ...t.layers,
          { ...input.layer, media: mi, start: t.duration },
        ];
      t.duration += input.extend;
      return t;
    });
  } catch (e) {
    await rm(libMediaPath(dest), { force: true });
    throw e;
  }
}

export async function renameTemplate(
  id: string,
  name: string,
): Promise<LibraryTemplate> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Template name required.");
  return mutateIndex((idx) => {
    const template = (idx.templates ?? []).find((t) => t.id === id);
    if (!template) throw new Error("Template not found.");
    template.name = trimmed.slice(0, 80);
    return template;
  });
}

export async function deleteTemplate(id: string) {
  const template = await mutateIndex((idx) => {
    const t = (idx.templates ?? []).find((x) => x.id === id);
    idx.templates = (idx.templates ?? []).filter((x) => x.id !== id);
    return t;
  });
  // The media copies are private to this template, so removing them is safe.
  for (const m of template?.media ?? [])
    await rm(libMediaPath(m.fileName), { force: true });
}
