import fsSync from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Aspect, ProjectDoc, ProjectFolder, ProjectSummary } from "@/cut/lib/types";
import { cutDataRoot } from "./dataDir";
import { assertLocalRuntime } from "./local-only";
import { exists, uniqueName, writeJsonAtomic } from "./util";

/** Projects live directly under the data root, shared by every account that
 * signs in on this Mac; each project is one folder holding project.json, its
 * raw media files, and its exports. The folder is named after the project —
 * that's what the user sees in Finder — and follows renames; the stable API
 * id lives in project.json, and resolveDirName maps id to folder. */
const projectsRoot = () => path.join(cutDataRoot(), "projects");
// Project folders are grouping metadata only; it lives beside the project dirs
// as a plain file, and the project scans skip non-directories.
const foldersIndex = () => path.join(projectsRoot(), "folders.json");

const ID_RE = /^[a-z0-9][a-z0-9-]{2,40}$/;

/** The Finder-safe folder name for a display name: path-hostile characters
 * become spaces, leading dots go (a hidden project folder helps nobody), and
 * an empty result falls back to Untitled. */
function dirNameFrom(name: string): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 60)
    .trim();
  return cleaned || "Untitled";
}

// Names inside projects/ that belong to the app itself, never to a project
// folder — a project literally named "folders.json" takes a suffix instead of
// sitting where writeFolders renames its index in.
const RESERVED_DIR_NAMES = new Set(["folders.json", "folders.json.bak"]);
const isReservedDirName = (name: string) => RESERVED_DIR_NAMES.has(name.toLowerCase());

/** Claim a free folder name by creating it — mkdir is the atomic check, so two
 * concurrent creates with the same name can't share a folder. */
async function claimDir(want: string): Promise<string> {
  await mkdir(projectsRoot(), { recursive: true });
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? want : `${want} ${n}`;
    if (isReservedDirName(candidate)) continue;
    try {
      fsSync.mkdirSync(path.join(projectsRoot(), candidate));
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

/** A folder's project doc, read for identity: project.json first, then the
 * .bak mirror, so one truncated save never makes the project unresolvable
 * while a good backup sits beside it. (readProject does the actual restore on
 * open; this only has to see the doc.) */
function readDocSyncAt(dir: string): { id?: string; name?: string } | null {
  for (const file of ["project.json", "project.json.bak"]) {
    try {
      return JSON.parse(fsSync.readFileSync(path.join(dir, file), "utf8")) as {
        id?: string;
        name?: string;
      };
    } catch {
      // Missing or unreadable; try the mirror.
    }
  }
  return null;
}

/** Sync twin of util.writeJsonAtomic for the startup reconcile: unique temp,
 * .bak written from the committed bytes, then renamed in. */
function writeDocSync(docFile: string, doc: unknown) {
  const json = JSON.stringify(doc, null, 2);
  const tmp = `${docFile}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  fsSync.writeFileSync(tmp, json);
  try {
    fsSync.writeFileSync(`${docFile}.bak`, json);
  } catch {
    // Best-effort mirror, like writeJsonAtomic.
  }
  fsSync.renameSync(tmp, docFile);
}

// id -> folder, maintained by every create/rename/delete in this process (the
// engine is the only writer). An entry remembers the folder's inode and is
// trusted only while the folder at that name still has it, so a folder
// swapped, replaced, or trashed in Finder can't satisfy a stale entry — the
// lookup falls through to a rescan instead of touching another project's
// folder. Unresolvable ids are remembered briefly (missCache) so a dead tab
// autosaving to a deleted project can't hammer the full scan on every request.
const dirIndex = new Map<string, { name: string; ino: number }>();
const missCache = new Map<string, number>();
const MISS_TTL_MS = 2000;

function setDirIndex(id: string, name: string) {
  try {
    dirIndex.set(id, { name, ino: fsSync.statSync(path.join(projectsRoot(), name)).ino });
    missCache.delete(id);
  } catch {
    dirIndex.delete(id);
  }
}

function resolveDirName(id: string): string | null {
  const root = projectsRoot();
  const cached = dirIndex.get(id);
  if (cached) {
    try {
      if (fsSync.statSync(path.join(root, cached.name)).ino === cached.ino) return cached.name;
    } catch {
      // Folder gone; rescan below.
    }
    dirIndex.delete(id);
  }
  const missedAt = missCache.get(id);
  if (missedAt !== undefined && Date.now() - missedAt < MISS_TTL_MS) return null;
  let entries: fsSync.Dirent[];
  try {
    entries = fsSync.readdirSync(root, { withFileTypes: true });
  } catch {
    missCache.set(id, Date.now());
    return null;
  }
  // Sorted, first claim of an id wins, so two folders carrying the same doc id
  // (a Finder duplicate) resolve deterministically; readProjectEntries gives
  // the twin its own id on the next listing.
  const seen = new Set<string>();
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    const doc = readDocSyncAt(path.join(root, e.name));
    if (!doc || typeof doc.id !== "string" || seen.has(doc.id)) continue;
    seen.add(doc.id);
    setDirIndex(doc.id, e.name);
  }
  const found = dirIndex.get(id)?.name ?? null;
  if (!found) missCache.set(id, Date.now());
  return found;
}

// jobs.ts registers the exports in flight; a folder never moves out from under
// a running ffmpeg render (the job's recorded output path must stay live).
// Registered by the jobs module at load; until then nothing renders, so
// nothing blocks.
let hasActiveJobs: (projectId: string) => boolean = () => false;
export function setActiveJobGuard(fn: (projectId: string) => boolean) {
  hasActiveJobs = fn;
}

/** Move the project's folder to match its display name. A conflict takes a
 * numeric suffix; an active render defers the move to the next save. The
 * target is claimed with mkdir first — POSIX rename replaces an empty
 * destination directory, so moving onto a placeholder we own is atomic, and a
 * concurrent create can never have its just-claimed folder replaced. */
function followName(id: string, name: string) {
  const current = resolveDirName(id);
  if (!current || hasActiveJobs(id)) return;
  const root = projectsRoot();
  const want = dirNameFrom(name);
  if (want.toLowerCase() === current.toLowerCase()) {
    if (want === current) return;
    // Case-only rename: same folder on a case-insensitive disk, so there is
    // nothing to claim — rename it in place.
    try {
      fsSync.renameSync(path.join(root, current), path.join(root, want));
      setDirIndex(id, want);
    } catch {
      dirIndex.delete(id);
    }
    return;
  }
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? want : `${want} ${n}`;
    if (isReservedDirName(candidate)) continue;
    // Already parked at this suffix (e.g. "Untitled 2" while "Untitled" is
    // taken): nothing to do.
    if (candidate.toLowerCase() === current.toLowerCase()) return;
    try {
      fsSync.mkdirSync(path.join(root, candidate));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      return;
    }
    try {
      fsSync.renameSync(path.join(root, current), path.join(root, candidate));
      setDirIndex(id, candidate);
    } catch {
      // The move failed; give the placeholder back and retry on a later save.
      try {
        fsSync.rmdirSync(path.join(root, candidate));
      } catch {
        // Leave it; a later claim will suffix past it.
      }
      dirIndex.delete(id);
    }
    return;
  }
}

export function projectDir(id: string) {
  assertLocalRuntime();
  if (!ID_RE.test(id)) throw new Error("Invalid project id.");
  // An unknown id falls back to a folder named by the id: a path that does not
  // exist, so reads fail exactly like a deleted project always has.
  return path.join(projectsRoot(), resolveDirName(id) ?? id);
}

/** Startup alignment, run by both mounts before data routes: stamp docs from
 * before stored ids (their folder name was the id) and move every folder to
 * match its display name. Running at every launch makes it one mechanism for
 * the one-time move off id-named folders, for suffixed folders reclaiming a
 * freed name, and for folders renamed in Finder while the engine was away. */
export function reconcileProjectDirs(): void {
  const root = projectsRoot();
  let entries: fsSync.Dirent[];
  try {
    entries = fsSync.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const doc = readDocSyncAt(path.join(root, e.name));
    if (!doc) continue;
    if (typeof doc.id !== "string" || !ID_RE.test(doc.id)) {
      if (!ID_RE.test(e.name)) continue;
      doc.id = e.name;
      try {
        // Atomic with a .bak mirror, like every other doc write — a plain
        // overwrite would leave the .bak holding an id-less doc that a later
        // corruption recovery restores.
        writeDocSync(path.join(root, e.name, "project.json"), doc);
      } catch {
        continue;
      }
    }
    setDirIndex(doc.id, e.name);
    followName(doc.id, typeof doc.name === "string" ? doc.name : "");
  }
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
    // The id resolved this folder, so it belongs on the restored doc — a .bak
    // from before ids were stored must not resurrect an id-less doc that the
    // project listing would drop.
    doc.id = id;
    await writeJsonAtomic(file, doc);
    return doc;
  } catch (err) {
    console.error(`Could not recover ${file} from backup:`, err);
    return null;
  }
}

export async function writeProject(id: string, doc: ProjectDoc) {
  doc.id = id;
  doc.updatedAt = Date.now();
  await writeJsonAtomic(docPath(id), doc);
  followName(id, doc.name);
}

export async function createProject(
  name: string,
  folderId: string | null = null,
  aspect: Aspect | null = null
): Promise<ProjectSummary> {
  const id = crypto.randomUUID().slice(0, 10);
  const displayName = name.trim() || "Untitled";
  const dirName = await claimDir(dirNameFrom(displayName));
  const dir = path.join(projectsRoot(), dirName);
  await mkdir(path.join(dir, "media"), { recursive: true });
  await mkdir(path.join(dir, "exports"), { recursive: true });
  setDirIndex(id, dirName);
  const now = Date.now();
  // A folder that no longer exists just falls back to the root.
  const folder =
    folderId && (await readFolders()).some((f) => f.id === folderId) ? folderId : null;
  const doc: ProjectDoc = {
    version: 1,
    id,
    name: displayName,
    createdAt: now,
    updatedAt: now,
    assets: [],
    clips: [],
    audioClips: [],
    overlays: [],
    ...(aspect ? { aspect } : {}),
    ...(folder ? { folderId: folder } : {}),
  };
  await writeJsonAtomic(path.join(dir, "project.json"), doc);
  return summarize(id, doc);
}

export async function deleteProject(id: string) {
  const dir = projectDir(id);
  const doc = await readProject(id);
  if (!doc) throw new Error("Project not found.");
  // Final backstop before an rm -rf: the folder's own doc must carry the id
  // being deleted, so a mis-resolved folder can never be the one removed.
  if (doc.id !== undefined && doc.id !== id) {
    dirIndex.delete(id);
    throw new Error("Project not found.");
  }
  await rm(dir, { recursive: true, force: true });
  dirIndex.delete(id);
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
    aspect: doc.aspect,
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
  await Promise.all(
    (await readProjectEntries()).map(async ({ id: projectId, doc }) => {
      if (doc.folderId === id) {
        doc.folderId = null;
        await writeProject(projectId, doc);
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
  const name = `${doc.name} copy`;
  const dirName = await claimDir(dirNameFrom(name));
  const dir = path.join(projectsRoot(), dirName);
  await mkdir(path.join(dir, "media"), { recursive: true });
  await mkdir(path.join(dir, "exports"), { recursive: true });
  setDirIndex(newId, dirName);
  await cp(mediaDir(id), path.join(dir, "media"), { recursive: true }).catch(() => {});
  const now = Date.now();
  const copy: ProjectDoc = { ...doc, id: newId, name, createdAt: now, updatedAt: now };
  await writeJsonAtomic(path.join(dir, "project.json"), copy);
  return summarize(newId, copy);
}

/** A folder's doc for listing: project.json, then the .bak mirror (the
 * restore itself happens when readProject opens it). */
async function readDocAt(dirName: string): Promise<ProjectDoc | null> {
  const base = path.join(projectsRoot(), dirName);
  for (const file of ["project.json", "project.json.bak"]) {
    try {
      return JSON.parse(await readFile(path.join(base, file), "utf8")) as ProjectDoc;
    } catch {
      // Missing or unreadable; try the mirror.
    }
  }
  return null;
}

/** Every project on disk: read each folder's doc concurrently — listing
 * latency shouldn't grow linearly with the number of projects. The scan
 * refreshes the id index, and it repairs duplicate ids: when two folders
 * carry the same doc id (a project duplicated in Finder), the one the index
 * already points at keeps the id — else the most recently edited — and each
 * twin is stamped with a fresh id of its own, making it the independent copy
 * the duplication was after. */
async function readProjectEntries(): Promise<{ id: string; doc: ProjectDoc }[]> {
  assertLocalRuntime();
  await mkdir(projectsRoot(), { recursive: true });
  const entries = await readdir(projectsRoot(), { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  const found = (
    await Promise.all(
      dirs.map(async (dirName) => {
        const doc = await readDocAt(dirName);
        if (!doc || typeof doc.id !== "string" || !ID_RE.test(doc.id)) return null;
        return { dirName, doc };
      })
    )
  ).filter((x): x is { dirName: string; doc: ProjectDoc } => x !== null);

  const byId = new Map<string, { dirName: string; doc: ProjectDoc }[]>();
  for (const entry of found) {
    const group = byId.get(entry.doc.id!) ?? [];
    group.push(entry);
    byId.set(entry.doc.id!, group);
  }

  const result: { id: string; doc: ProjectDoc }[] = [];
  for (const [id, group] of byId) {
    const indexed = dirIndex.get(id)?.name;
    const keeper =
      group.find((g) => g.dirName === indexed) ??
      group.reduce((a, b) => (b.doc.updatedAt > a.doc.updatedAt ? b : a));
    setDirIndex(id, keeper.dirName);
    result.push({ id, doc: keeper.doc });
    for (const twin of group) {
      if (twin === keeper) continue;
      const freshId = crypto.randomUUID().slice(0, 10);
      twin.doc.id = freshId;
      try {
        await writeJsonAtomic(path.join(projectsRoot(), twin.dirName, "project.json"), twin.doc);
        setDirIndex(freshId, twin.dirName);
        result.push({ id: freshId, doc: twin.doc });
        console.log(`re-identified duplicate project folder "${twin.dirName}" as ${freshId}`);
      } catch {
        // Unwritable twin: leave it off the list; the winner keeps the id.
      }
    }
  }
  return result;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const found = await readProjectEntries();
  const summaries = await Promise.all(found.map(({ id, doc }) => summarize(id, doc)));
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
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
