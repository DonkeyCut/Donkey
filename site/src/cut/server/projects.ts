import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectDoc, ProjectFolder, ProjectSummary } from "@/cut/lib/types";
import { cutDataRoot } from "./dataDir";
import { assertLocalRuntime } from "./local-only";
import { exists, uniqueName, writeJsonAtomic } from "./util";

/** Projects live directly under the data root, shared by every account that
 * signs in on this Mac; each project is one folder holding project.json, its
 * raw media files, and its exports. */
const projectsRoot = () => path.join(cutDataRoot(), "projects");
// Project folders are grouping metadata only; it lives beside the project dirs
// as a plain file, so the project-dir scan (which requires ID_RE) skips it.
const foldersIndex = () => path.join(projectsRoot(), "folders.json");

const ID_RE = /^[a-z0-9][a-z0-9-]{2,40}$/;

export function projectDir(id: string) {
  assertLocalRuntime();
  if (!ID_RE.test(id)) throw new Error("Invalid project id.");
  return path.join(projectsRoot(), id);
}

export const mediaDir = (id: string) => path.join(projectDir(id), "media");
export const exportsDir = (id: string) => path.join(projectDir(id), "exports");
/** A low-res proxy of the actual edit, played on the project card's hover. */
export const previewPath = (id: string) => path.join(projectDir(id), "preview.mp4");

export function mediaPath(id: string, fileName: string) {
  const safe = path.basename(fileName);
  if (!safe || safe.startsWith(".")) throw new Error("Invalid file name.");
  return path.join(mediaDir(id), safe);
}

export function exportPath(id: string, fileName: string) {
  const safe = path.basename(fileName);
  if (!safe || safe.startsWith(".")) throw new Error("Invalid file name.");
  return path.join(exportsDir(id), safe);
}

/** Rendered exports in the project folder, newest first. */
export async function listExports(id: string) {
  const dir = exportsDir(id);
  const names = await readdir(dir).catch(() => [] as string[]);
  const items = await Promise.all(
    names
      .filter((n) => n.endsWith(".mp4"))
      .map(async (n) => {
        const info = await stat(path.join(dir, n)).catch(() => null);
        return info?.isFile() && info.size > 0
          ? { file: n, size: info.size, mtime: info.mtimeMs }
          : null;
      })
  );
  return items
    .filter((x): x is { file: string; size: number; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime);
}

/** Remove one rendered export from the project folder. */
export async function deleteExport(id: string, fileName: string) {
  await rm(exportPath(id, fileName), { force: true });
}

/** Remove one media file from the project folder — a media file dies with the
 * last asset that referenced it, so deleted assets don't pile up on disk. */
export async function deleteMedia(id: string, fileName: string) {
  await rm(mediaPath(id, fileName), { force: true });
}

const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Delete media files the doc doesn't reference. Everything under media/ is
 * written to become a doc asset, so an unreferenced file landed for a client
 * that never adopted it — a chat import finishing after the page closed. A day
 * of mtime grace keeps anything a live client might still register. */
export async function sweepOrphanMedia(id: string, doc: ProjectDoc): Promise<void> {
  const dir = mediaDir(id);
  const names = await readdir(dir).catch(() => [] as string[]);
  const referenced = new Set(doc.assets.map((a) => a.fileName));
  const cutoff = Date.now() - ORPHAN_MAX_AGE_MS;
  for (const name of names) {
    if (referenced.has(name) || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    const info = await stat(p).catch(() => null);
    if (info?.isFile() && info.mtimeMs < cutoff) await rm(p, { force: true });
  }
}

const docPath = (id: string) => path.join(projectDir(id), "project.json");

export async function readProject(id: string): Promise<ProjectDoc | null> {
  const file = docPath(id);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as ProjectDoc;
  } catch (err) {
    console.error(`Corrupt project doc ${file}:`, err);
  }
  try {
    const doc = JSON.parse(await readFile(`${file}.bak`, "utf8")) as ProjectDoc;
    await writeJsonAtomic(file, doc);
    return doc;
  } catch (err) {
    console.error(`Could not recover ${file} from backup:`, err);
    return null;
  }
}

export async function writeProject(id: string, doc: ProjectDoc) {
  doc.updatedAt = Date.now();
  await writeJsonAtomic(docPath(id), doc);
}

export async function createProject(
  name: string,
  folderId: string | null = null
): Promise<ProjectSummary> {
  const id = crypto.randomUUID().slice(0, 10);
  await mkdir(mediaDir(id), { recursive: true });
  await mkdir(exportsDir(id), { recursive: true });
  const now = Date.now();
  // A folder that no longer exists just falls back to the root.
  const folder =
    folderId && (await readFolders()).some((f) => f.id === folderId) ? folderId : null;
  const doc: ProjectDoc = {
    version: 1,
    name: name.trim() || "Untitled",
    createdAt: now,
    updatedAt: now,
    assets: [],
    clips: [],
    audioClips: [],
    overlays: [],
    ...(folder ? { folderId: folder } : {}),
  };
  await writeJsonAtomic(docPath(id), doc);
  return summarize(id, doc);
}

export async function deleteProject(id: string) {
  const dir = projectDir(id);
  if (!(await exists(docPath(id)))) throw new Error("Project not found.");
  await rm(dir, { recursive: true, force: true });
}

/** Total bytes under a directory (media, exports, proxy, doc). */
async function dirSize(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else {
      const info = await stat(p).catch(() => null);
      if (info) total += info.size;
    }
  }
  return total;
}

async function summarize(id: string, doc: ProjectDoc): Promise<ProjectSummary> {
  // Track 0 is the cut: layer clips composite over it, so they add nothing to
  // the summary's duration, count, or poster. Legacy docs carry no `track` on
  // clips — those are all track 0.
  const track0 = doc.clips.filter((c) => (c.track ?? 0) === 0);
  const duration = track0.reduce((sum, c) => sum + Math.max(0, c.out - c.in), 0);
  // Preview: the first clip's source video, else any video asset.
  const firstClip = track0[0];
  const firstClipAsset = firstClip
    ? doc.assets.find((a) => a.id === firstClip.assetId)
    : undefined;
  const previewAsset =
    firstClipAsset ?? doc.assets.find((a) => a.type === "video" || a.type === "image");
  // Poster the clip's actual first frame (its trim-in), not the source's 0s.
  const previewStart = firstClipAsset && firstClip ? firstClip.in : 0;
  const [hasPreview, sizeBytes] = await Promise.all([
    exists(previewPath(id)),
    dirSize(projectDir(id)),
  ]);
  return {
    id,
    name: doc.name,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    duration,
    clipCount: track0.length,
    assetCount: doc.assets.length,
    previewFile: previewAsset?.fileName,
    previewIsImage: previewAsset?.type === "image",
    previewStart,
    hasPreview,
    folderId: doc.folderId ?? null,
    sizeBytes,
  };
}

// --- Project folders: a flat set of named groups; each project's doc carries
// its folderId, so grouping travels with the project. ---

async function readFolders(): Promise<ProjectFolder[]> {
  try {
    const raw = JSON.parse(await readFile(foldersIndex(), "utf8")) as { folders?: ProjectFolder[] };
    return Array.isArray(raw.folders) ? raw.folders : [];
  } catch {
    return [];
  }
}

async function writeFolders(folders: ProjectFolder[]) {
  await mkdir(projectsRoot(), { recursive: true });
  await writeJsonAtomic(foldersIndex(), { folders });
}

export async function listProjectFolders(): Promise<ProjectFolder[]> {
  return (await readFolders()).sort((a, b) => a.createdAt - b.createdAt);
}

export async function createProjectFolder(name: string): Promise<ProjectFolder> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Folder name required.");
  const folder: ProjectFolder = {
    id: crypto.randomUUID().slice(0, 8),
    name: trimmed.slice(0, 80),
    createdAt: Date.now(),
  };
  await writeFolders([...(await readFolders()), folder]);
  return folder;
}

export async function renameProjectFolder(id: string, name: string): Promise<ProjectFolder> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Folder name required.");
  const folders = await readFolders();
  const folder = folders.find((f) => f.id === id);
  if (!folder) throw new Error("Folder not found.");
  folder.name = trimmed.slice(0, 80);
  await writeFolders(folders);
  return folder;
}

export async function deleteProjectFolder(id: string) {
  await writeFolders((await readFolders()).filter((f) => f.id !== id));
  // Projects in the folder fall back to ungrouped rather than disappearing.
  const entries = await readdir(projectsRoot(), { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries
      .filter((e) => e.isDirectory() && ID_RE.test(e.name))
      .map(async (e) => {
        const doc = await readProject(e.name);
        if (doc && doc.folderId === id) {
          doc.folderId = null;
          await writeProject(e.name, doc);
        }
      })
  );
}

export async function moveProjectToFolder(id: string, folderId: string | null) {
  const doc = await readProject(id);
  if (!doc) throw new Error("Project not found.");
  if (folderId && !(await readFolders()).some((f) => f.id === folderId)) {
    throw new Error("Folder not found.");
  }
  doc.folderId = folderId;
  await writeProject(id, doc);
}

/** Duplicate a project: copy the doc and its media (not its exports) into a
 * fresh project folder. */
export async function duplicateProject(id: string): Promise<ProjectSummary> {
  const doc = await readProject(id);
  if (!doc) throw new Error("Project not found.");
  const newId = crypto.randomUUID().slice(0, 10);
  await mkdir(mediaDir(newId), { recursive: true });
  await mkdir(exportsDir(newId), { recursive: true });
  await cp(mediaDir(id), mediaDir(newId), { recursive: true }).catch(() => {});
  const now = Date.now();
  const copy: ProjectDoc = { ...doc, name: `${doc.name} copy`, createdAt: now, updatedAt: now };
  await writeJsonAtomic(docPath(newId), copy);
  return summarize(newId, copy);
}

export async function listProjects(): Promise<ProjectSummary[]> {
  assertLocalRuntime();
  await mkdir(projectsRoot(), { recursive: true });
  const entries = await readdir(projectsRoot(), { withFileTypes: true });
  const names = entries
    .filter((e) => e.isDirectory() && ID_RE.test(e.name))
    .map((e) => e.name);
  // Read every project.json concurrently — listing latency shouldn't grow
  // linearly with the number of projects.
  const docs = await Promise.all(names.map((n) => readProject(n)));
  const summaries = await Promise.all(
    names.map((n, i) => (docs[i] ? summarize(n, docs[i]!) : Promise.resolve(null)))
  );
  return summaries
    .filter((x): x is ProjectSummary => x !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Store an uploaded media file in the project folder, deduping the name. */
export async function saveMedia(id: string, file: File): Promise<string> {
  await mkdir(mediaDir(id), { recursive: true });
  const base = path
    .basename(file.name)
    .replace(/[^\w.\-() ]+/g, "_")
    .slice(-80);
  const fileName = await uniqueName(base, (n) => mediaPath(id, n));
  await writeFile(mediaPath(id, fileName), Buffer.from(await file.arrayBuffer()));
  return fileName;
}
