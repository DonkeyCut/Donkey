// The browser store: Cut projects on the page's own origin-private disk.
//
// The tree mirrors the engine's data dir, scoped per signed-in account
// because OPFS is per-origin and one machine serves many accounts:
//
//   cut-store/users/<accountId>/
//     index.json                    folders + media sync ledger
//     projects/<projectId>/
//       project.json                the doc (createWritable commits on close,
//                                   so a torn write never replaces a good doc)
//       media/<fileName>
//       exports/<fileName>
//
// Project directories are named by id — no Finder here, so nothing follows
// display names. Everything is functions over handles; no module-level DOM or
// storage access, because this file rides along in the engine bundle.
import type { ProjectDoc, ProjectFolder, ProjectSummary } from "../../types";
import { currentEngineUser } from "../../api";

const ROOT_DIR = "cut-store";

/** Whether this browser can hold a store: OPFS with committed writes. The
 * same capability line the in-tab render draws. */
export function supportsBrowserStore(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function" &&
    typeof FileSystemFileHandle !== "undefined" &&
    "createWritable" in FileSystemFileHandle.prototype
  );
}

const accountId = () => currentEngineUser() ?? "-";

async function dirAt(parts: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    let dir = await navigator.storage.getDirectory();
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
    return dir;
  } catch {
    return null;
  }
}

const userParts = () => [ROOT_DIR, "users", accountId()];
const projectParts = (id: string) => [...userParts(), "projects", id];

export const projectsDir = (create = false) => dirAt([...userParts(), "projects"], create);
export const projectDir = (id: string, create = false) => dirAt(projectParts(id), create);
export const mediaDir = (id: string, create = false) => dirAt([...projectParts(id), "media"], create);
export const exportsDir = (id: string, create = false) =>
  dirAt([...projectParts(id), "exports"], create);

/** One storage-persistence ask per session, on the first write that makes
 * this browser hold something worth keeping. */
let persistAsked = false;
export function askPersist(): void {
  if (persistAsked) return;
  persistAsked = true;
  try {
    void navigator.storage.persist?.().catch(() => {});
  } catch {
    // Denied or unsupported: the store still works, eviction just stays
    // possible; the UI reads navigator.storage.persisted() where it matters.
  }
}

/** Serialize writers of shared files (index.json) across tabs. Falls through
 * to running bare where Web Locks are unavailable. */
export async function withStoreLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks) return fn();
  return locks.request(`cut-store:${accountId()}:${name}`, fn) as Promise<T>;
}

// --- file primitives ---

export async function readFileAt(
  dir: FileSystemDirectoryHandle | null,
  name: string
): Promise<File | null> {
  if (!dir) return null;
  try {
    return await (await dir.getFileHandle(name)).getFile();
  } catch {
    return null;
  }
}

export async function writeFileAt(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: Blob | ArrayBuffer | string
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const w = await handle.createWritable();
  try {
    await w.write(data);
  } catch (err) {
    await w.abort().catch(() => {});
    throw err;
  }
  await w.close();
}

async function readJsonAt<T>(dir: FileSystemDirectoryHandle | null, name: string): Promise<T | null> {
  const file = await readFileAt(dir, name);
  if (!file) return null;
  try {
    return JSON.parse(await file.text()) as T;
  } catch {
    return null;
  }
}

// --- index: folders + the media sync ledger ---

/** A cloud project's media file the cloud doesn't hold yet. The entry is the
 * pin: media listed here exists only in this browser and is never evicted;
 * the sync queue drains it and clears the entry. */
export type PendingUpload = {
  projectId: string;
  fileName: string;
  /** Bytes, for queue ordering and the storage pill. */
  size: number;
  addedAt: number;
};

type StoreIndex = {
  version: 1;
  folders: ProjectFolder[];
  pendingUploads: PendingUpload[];
  /** When each project was last opened here — the recency order eviction
   * walks when the store needs room. */
  opens: Record<string, number>;
};

const EMPTY_INDEX: StoreIndex = { version: 1, folders: [], pendingUploads: [], opens: {} };

export async function readIndex(): Promise<StoreIndex> {
  const idx = await readJsonAt<StoreIndex>(await dirAt(userParts(), false), "index.json");
  return idx && Array.isArray(idx.folders)
    ? { ...EMPTY_INDEX, ...idx, pendingUploads: idx.pendingUploads ?? [], opens: idx.opens ?? {} }
    : EMPTY_INDEX;
}

export async function updateIndex(mutate: (idx: StoreIndex) => StoreIndex | void): Promise<StoreIndex> {
  return withStoreLock("index", async () => {
    const dir = await dirAt(userParts(), true);
    if (!dir) throw new Error("Browser storage is unavailable.");
    const idx = await readIndex();
    const next = mutate(idx) ?? idx;
    await writeFileAt(dir, "index.json", JSON.stringify(next));
    return next;
  });
}

// --- docs ---

export async function readDoc(id: string): Promise<ProjectDoc | null> {
  return readJsonAt<ProjectDoc>(await projectDir(id), "project.json");
}

export async function writeDoc(id: string, doc: ProjectDoc): Promise<void> {
  const dir = await projectDir(id, true);
  if (!dir) throw new Error("Browser storage is unavailable.");
  doc.id = id;
  doc.updatedAt = Date.now();
  await writeFileAt(dir, "project.json", JSON.stringify(doc));
}

/** Every project id in the store (directories holding a readable doc). */
export async function listProjectIds(): Promise<string[]> {
  const dir = await projectsDir();
  if (!dir) return [];
  const ids: string[] = [];
  try {
    for await (const [name, handle] of dir) {
      if (handle.kind === "directory") ids.push(name);
    }
  } catch {
    return ids;
  }
  return ids;
}

async function dirBytes(dir: FileSystemDirectoryHandle | null): Promise<number> {
  if (!dir) return 0;
  let total = 0;
  try {
    for await (const [, handle] of dir) {
      if (handle.kind === "file") {
        total += (await (handle as FileSystemFileHandle).getFile()).size;
      } else {
        total += await dirBytes(handle as FileSystemDirectoryHandle);
      }
    }
  } catch {
    // Partial totals are fine; this feeds a size hint, never a decision.
  }
  return total;
}

/** The engine's summary shape for a doc in the store. */
export async function summarize(id: string, doc: ProjectDoc): Promise<ProjectSummary> {
  const track0 = doc.clips.filter((c) => (c.track ?? 0) === 0);
  const firstClip = track0[0];
  const firstClipAsset = firstClip ? doc.assets.find((a) => a.id === firstClip.assetId) : undefined;
  const previewAsset =
    firstClipAsset ?? doc.assets.find((a) => a.type === "video" || a.type === "image");
  return {
    id,
    name: doc.name,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    duration: track0.reduce((sum, c) => sum + Math.max(0, c.out - c.in), 0),
    clipCount: track0.length,
    assetCount: doc.assets.length,
    previewFile: previewAsset?.fileName,
    previewIsImage: previewAsset?.type === "image",
    previewStart: firstClipAsset && firstClip ? firstClip.in : 0,
    hasPreview: false,
    aspect: doc.aspect,
    folderId: doc.folderId ?? null,
    sizeBytes: await dirBytes(await projectDir(id)),
  };
}

// --- media ---

/** Store media bytes under a deduped name — the engine's sanitize + suffix
 * rules, so a project copied across residencies keeps consistent names. */
export async function saveMedia(id: string, file: File, wantName?: string): Promise<string> {
  const dir = await mediaDir(id, true);
  if (!dir) throw new Error("Browser storage is unavailable.");
  const base = (wantName ?? file.name)
    .split("/")
    .pop()!
    .replace(/[^\w.\-() ]+/g, "_")
    .slice(-80);
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot) : "";
  const stem = (dot > 0 ? base.slice(0, dot) : base) || "media";
  let name = base || `media${ext}`;
  for (let n = 1; await readFileAt(dir, name); n++) name = `${stem}-${n}${ext}`;
  await writeFileAt(dir, name, file);
  askPersist();
  return name;
}

export async function deleteMedia(id: string, fileName: string): Promise<void> {
  const dir = await mediaDir(id);
  await dir?.removeEntry(fileName).catch(() => {});
}

export async function deleteProject(id: string): Promise<void> {
  const dir = await projectsDir();
  await dir?.removeEntry(id, { recursive: true }).catch(() => {});
}

// --- exports ---

export type ExportListing = { file: string; size: number; mtime: number };

export async function listExports(id: string): Promise<ExportListing[]> {
  const dir = await exportsDir(id);
  if (!dir) return [];
  const items: ExportListing[] = [];
  try {
    for await (const [name, handle] of dir) {
      if (handle.kind !== "file" || !name.endsWith(".mp4")) continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      if (file.size > 0) items.push({ file: name, size: file.size, mtime: file.lastModified });
    }
  } catch {
    // A half-listed exports shelf still renders.
  }
  return items.sort((a, b) => b.mtime - a.mtime);
}

/** Land a finished render in exports/, deduping like media names do. */
export async function saveExport(id: string, file: File, wantName: string): Promise<string> {
  const dir = await exportsDir(id, true);
  if (!dir) throw new Error("Browser storage is unavailable.");
  const dot = wantName.lastIndexOf(".");
  const ext = dot > 0 ? wantName.slice(dot) : ".mp4";
  const stem = dot > 0 ? wantName.slice(0, dot) : wantName;
  let name = wantName;
  for (let n = 1; await readFileAt(dir, name); n++) name = `${stem}-${n}${ext}`;
  await writeFileAt(dir, name, file);
  askPersist();
  return name;
}

export async function deleteExport(id: string, fileName: string): Promise<void> {
  const dir = await exportsDir(id);
  await dir?.removeEntry(fileName).catch(() => {});
}
