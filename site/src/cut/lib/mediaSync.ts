// A cloud project's working copy in the browser store.
//
// Imports land here first: the dropped bytes are written into OPFS under the
// name the cloud claimed, the asset plays from a blob URL over those bytes,
// and the upload to R2 drains in the background (importQueue). The ledger in
// the store's index — `pendingUploads` — is what makes that durable: an entry
// means this browser holds the only copy, so the file is pinned and the next
// open re-marks the asset and resumes the upload. Once the cloud confirms the
// object, the entry clears and the local file becomes a read cache.
//
// The cache side runs the other way: opening a cloud project prefetches every
// asset this browser is missing — one file at a time, nearest timeline use
// first, so the downloads never race each other for bandwidth — and each file
// that lands swaps the playing asset onto its local bytes. Scrubbing goes
// local as the queue drains, and the next open plays entirely from disk.
//
// Cached copies are also what eviction spends: when the origin's storage
// quota runs short, the least recently opened cloud projects' caches are
// dropped to make room. Pinned files (a `pendingUploads` entry means this
// browser holds the only copy) and browser-resident projects (their store IS
// the project) are never touched — losing a cache only costs a re-download.
//
// Every function is a no-op wherever the browser can't hold a store, so call
// sites stay unconditional.
import {
  askPersist,
  deleteMedia,
  deleteProject,
  listProjectIds,
  mediaDir,
  projectDir,
  readFileAt,
  readIndex,
  saveMedia,
  supportsBrowserStore,
  updateIndex,
  writeFileAt,
  type PendingUpload,
} from "./backend/browser/opfs";
import {
  forgetRegistered,
  registerBlobFile,
  registeredUrl,
  revokeRegistered,
} from "./backend/browser/registry";
import { getBackend, type CutBackend } from "./backend";
import { dropChunksMatching, evictChunkBytes, prefetchChunks } from "./chunkCache";
import { mediaUrl, type AssetType } from "./types";

const mediaPath = (projectId: string, fileName: string) =>
  `/api/cut/projects/${projectId}/media/${encodeURIComponent(fileName)}`;

/** Write an import's bytes into the store under the name the cloud claimed
 * and pin them in the ledger. Returns the blob URL the asset plays from, or
 * null when the store can't hold it — the import then stays tab-scoped and
 * uploads the way it always has. */
export async function stashCloudMedia(
  projectId: string,
  file: File,
  fileName: string
): Promise<string | null> {
  if (!supportsBrowserStore()) return null;
  try {
    await makeRoom(projectId, file.size);
    const dir = await mediaDir(projectId, true);
    if (!dir) return null;
    await writeFileAt(dir, fileName, file);
    askPersist();
    await updateIndex((idx) => {
      idx.pendingUploads = [
        ...idx.pendingUploads.filter((p) => p.projectId !== projectId || p.fileName !== fileName),
        { projectId, fileName, size: file.size, addedAt: Date.now() },
      ];
    });
    return registerBlobFile(mediaPath(projectId, fileName), file);
  } catch {
    return null;
  }
}

/** Stash an import the cloud refused to claim (a full account's 413): the
 * bytes land under a locally deduped name and stay pinned until the drain
 * claims a cloud name for them. The claim is the cloud's to resolve, so the
 * name can shift when it lands — `renameLocalMedia` follows it. */
export async function stashUnclaimedMedia(
  projectId: string,
  file: File
): Promise<{ fileName: string; url: string } | null> {
  if (!supportsBrowserStore()) return null;
  try {
    await makeRoom(projectId, file.size);
    const fileName = await saveMedia(projectId, file, file.name);
    await updateIndex((idx) => {
      idx.pendingUploads = [
        ...idx.pendingUploads,
        { projectId, fileName, size: file.size, addedAt: Date.now() },
      ];
    });
    return { fileName, url: registerBlobFile(mediaPath(projectId, fileName), file) };
  } catch {
    return null;
  }
}

/** Follow a cloud claim that resolved to a different name: move the stored
 * bytes, their pin, and their blob URL onto it. */
export async function renameLocalMedia(
  projectId: string,
  from: string,
  to: string
): Promise<void> {
  if (!supportsBrowserStore() || from === to) return;
  try {
    const file = await readFileAt(await mediaDir(projectId), from);
    if (!file) return;
    const dir = await mediaDir(projectId, true);
    if (!dir) return;
    await writeFileAt(dir, to, file);
    registerBlobFile(mediaPath(projectId, to), file);
    // Decoders repoint when the asset's URL swaps to the new name; let the
    // frame they are painting finish before the old URL dies under them.
    setTimeout(() => revokeRegistered(mediaPath(projectId, from)), 10_000);
    await dir.removeEntry(from).catch(() => {});
    await updateIndex((idx) => {
      idx.pendingUploads = idx.pendingUploads.map((p) =>
        p.projectId === projectId && p.fileName === from ? { ...p, fileName: to } : p
      );
    });
  } catch {
    // The old copy stands; the next resume walks the same path.
  }
}

/** The upload landed (or its object turned out to already exist): unpin. The
 * local file stays on as a read cache. */
export async function clearPendingUpload(projectId: string, fileName: string): Promise<void> {
  if (!supportsBrowserStore()) return;
  try {
    await updateIndex((idx) => {
      idx.pendingUploads = idx.pendingUploads.filter(
        (p) => p.projectId !== projectId || p.fileName !== fileName
      );
    });
  } catch {
    // A stale pin costs a redundant resume, which the server answers "done".
  }
}

/** The ledger entries pinning this project's unsynced media. */
export async function pendingUploadsFor(projectId: string): Promise<PendingUpload[]> {
  if (!supportsBrowserStore()) return [];
  try {
    return (await readIndex()).pendingUploads.filter((p) => p.projectId === projectId);
  } catch {
    return [];
  }
}

/** The store's copy of a cloud project's media file, when it holds one. */
export async function localMediaFile(projectId: string, fileName: string): Promise<File | null> {
  if (!supportsBrowserStore()) return null;
  return readFileAt(await mediaDir(projectId), fileName);
}

/** The blob URL for a locally held media file, minting it on first ask.
 * Null when the store has no copy — the caller falls back to a signed URL. */
export async function localMediaUrl(projectId: string, fileName: string): Promise<string | null> {
  if (!supportsBrowserStore()) return null;
  const path = mediaPath(projectId, fileName);
  const prior = registeredUrl(path);
  if (prior) return prior;
  const file = await localMediaFile(projectId, fileName);
  return file ? registerBlobFile(path, file) : null;
}

/** Forget the blob URL minted for a stored file. It failed to read, so the
 * next resolve mints afresh from the file the store holds now. */
export function forgetLocalMediaUrl(projectId: string, fileName: string): void {
  forgetRegistered(mediaPath(projectId, fileName));
}

/** Where an asset plays a stored project file from, best address first: this
 * browser's own copy, a signed link on the media origin (the one origin the
 * chunk cache keeps), then the route URL, which re-signs and redirects on
 * every read. Every asset that lands at rest — a drop, a generation, a freeze,
 * a conversion, a template copy — is stamped through here, and a blob URL that
 * failed to read is re-resolved through here, so a new kind of asset inherits
 * the same address and the same healing. The engine serves its files itself. */
export async function storedMediaUrl(
  projectId: string,
  fileName: string,
  backend: CutBackend = getBackend()
): Promise<string> {
  if (backend.kind !== "local") {
    const local = await localMediaUrl(projectId, fileName);
    if (local) return local;
    const signed = await import("./mediaLinks")
      .then((m) => m.mintLandedUrl(projectId, fileName))
      .catch(() => null);
    if (signed) return signed;
  }
  return mediaUrl(projectId, fileName, backend);
}

/** A media delete's local half: the file, its chunks, its blob URL, its pin. */
export async function dropLocalMedia(projectId: string, fileName: string): Promise<void> {
  if (!supportsBrowserStore()) return;
  revokeRegistered(mediaPath(projectId, fileName));
  await deleteMedia(projectId, fileName).catch(() => {});
  void dropChunksMatching(`/projects/${projectId}/media/${fileName}`);
  await clearPendingUpload(projectId, fileName);
}

/** A project delete's local half: its whole subtree, URLs, and pins. */
export async function dropLocalProjectCopy(projectId: string): Promise<void> {
  if (!supportsBrowserStore()) return;
  if (prefetch?.projectId === projectId) prefetch.ctrl.abort();
  revokeRegistered(`/api/cut/projects/${projectId}/`);
  void dropChunksMatching(`/projects/${projectId}/`);
  await deleteProject(projectId).catch(() => {});
  try {
    await updateIndex((idx) => {
      idx.pendingUploads = idx.pendingUploads.filter((p) => p.projectId !== projectId);
      delete idx.opens[projectId];
    });
  } catch {
    // Orphaned pins for a gone project are swept on the next open attempt.
  }
}

// --- prefetch ---

type PrefetchRun = { projectId: string; ctrl: AbortController };
let prefetch: PrefetchRun | null = null;

/** Prefetch a cloud project's missing media into the store, one file at a
 * time in the order given. Video fills the chunk cache (chunkCache.ts): the
 * asset keeps its signed URL, playback reads resident chunks off disk, and an
 * interrupted walk keeps every chunk it landed. Other files stream in whole
 * and swap onto blob URLs, so an <img> paints local bytes offline. Every file
 * reports back through `onDone` exactly once — its blob URL when whole bytes
 * landed, null otherwise — so the caller can swap playing assets mid-session
 * and retire per-file loading state either way. Starting a prefetch cancels
 * any earlier one — the queue follows the open project — and records the open
 * for eviction recency. Fire-and-forget; a failed or refused write costs
 * nothing but the cache. */
export function prefetchCloudMedia(
  projectId: string,
  files: { fileName: string; url: string; type?: AssetType }[],
  onDone?: (fileName: string, blobUrl: string | null) => void
): void {
  if (!supportsBrowserStore()) {
    for (const f of files) onDone?.(f.fileName, null);
    return;
  }
  prefetch?.ctrl.abort();
  const run: PrefetchRun = { projectId, ctrl: new AbortController() };
  prefetch = run;
  void (async () => {
    await updateIndex((idx) => {
      idx.opens = { ...idx.opens, [projectId]: Date.now() };
    }).catch(() => {});
    for (let i = 0; i < files.length; i++) {
      if (run.ctrl.signal.aborted) return;
      const f = files[i];
      const r =
        f.type === "video"
          ? await cacheVideoChunks(f.url, run.ctrl.signal)
          : await cacheOne(projectId, f.fileName, f.url, run.ctrl.signal).catch(
              // Offline mid-stream: the abort discarded the partial write.
              () => ({ go: true, url: null as string | null })
            );
      if (run.ctrl.signal.aborted) return;
      onDone?.(f.fileName, r.url);
      if (!r.go) {
        // Out of room even after eviction — signed URLs carry the rest.
        for (const rest of files.slice(i + 1)) onDone?.(rest.fileName, null);
        return;
      }
    }
  })();
}

/** Walk a video's chunks into the chunk cache. The asset plays through its
 * signed URL either way, so any failure just leaves the file partial —
 * on-demand reads finish it — and the queue always goes on. */
async function cacheVideoChunks(
  url: string,
  signal: AbortSignal
): Promise<{ go: boolean; url: string | null }> {
  await prefetchChunks(url, signal).catch(() => {});
  return { go: !signal.aborted, url: null };
}

/** Stream one file into the store. `go: false` means storage is out of room
 * even after eviction, which ends the whole run. */
async function cacheOne(
  projectId: string,
  fileName: string,
  url: string,
  signal: AbortSignal
): Promise<{ go: boolean; url: string | null }> {
  const path = mediaPath(projectId, fileName);
  const prior = registeredUrl(path);
  if (prior) return { go: true, url: prior };
  const existing = await localMediaFile(projectId, fileName);
  if (existing) return { go: true, url: registerBlobFile(path, existing) };
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { signal });
    if (!res.ok || !res.body) return { go: true, url: null };
    await makeRoom(projectId, Number(res.headers.get("content-length")) || 0);
    const dir = await mediaDir(projectId, true);
    if (!dir) return { go: true, url: null };
    // The directory can go out from under this between the two awaits — an
    // eviction pass sweeping a copy, or the origin's store cleared from
    // browser settings. The signed URL still serves the file either way.
    const w = await dir
      .getFileHandle(fileName, { create: true })
      .then((h) => h.createWritable())
      .catch(() => null);
    if (!w) return { go: true, url: null };
    try {
      await res.body.pipeTo(w, { signal });
      break;
    } catch (err) {
      // pipeTo aborts the writable, which discards the partial write.
      if (signal.aborted) return { go: false, url: null };
      const quota = err instanceof DOMException && err.name === "QuotaExceededError";
      if (!quota) return { go: true, url: null }; // a blip skips this file, the queue goes on
      if (attempt > 0) return { go: false, url: null };
      // The room estimate undershot; evict against what the stream really
      // needed and give the file one more pass.
      await makeRoom(projectId, res.headers.get("content-length") ? 0 : 1 << 30);
    }
  }
  const file = await readFileAt(await mediaDir(projectId), fileName);
  return { go: true, url: file ? registerBlobFile(path, file) : null };
}

// --- eviction ---

/** Free space to keep under the origin's storage quota beyond what a write
 * needs, so caching never runs the store to the brim. */
const QUOTA_MARGIN = 512 * 1024 * 1024;

/** Make room for `bytes` of new media, evicting least-recently-opened cloud
 * projects' cached copies until the write fits under quota. Pinned files and
 * browser-resident projects are exempt; `keepId` (the project being written)
 * is never a candidate. */
async function makeRoom(keepId: string, bytes: number): Promise<void> {
  let est: StorageEstimate | undefined;
  try {
    est = await navigator.storage.estimate?.();
  } catch {
    return;
  }
  if (!est?.quota) return;
  const margin = Math.min(QUOTA_MARGIN, est.quota * 0.1);
  let deficit = (est.usage ?? 0) + bytes + margin - est.quota;
  if (deficit <= 0) return;
  // The chunk cache is the cheapest byte to lose — losing one costs a ranged
  // re-fetch, where losing a whole-file copy costs the file — so it goes first.
  deficit -= await evictChunkBytes(deficit);
  if (deficit <= 0) return;
  const idx = await readIndex();
  const pinned = new Set(idx.pendingUploads.map((p) => `${p.projectId}/${p.fileName}`));
  const candidates: { id: string; openedAt: number }[] = [];
  for (const id of await listProjectIds()) {
    if (id === keepId) continue;
    // A directory holding a doc is a browser-resident project — the store is
    // its only home. Cached cloud copies hold media alone.
    if (await readFileAt(await projectDir(id), "project.json")) continue;
    candidates.push({ id, openedAt: idx.opens[id] ?? 0 });
  }
  candidates.sort((a, b) => a.openedAt - b.openedAt);
  for (const c of candidates) {
    if (deficit <= 0) return;
    deficit -= await evictCachedCopy(c.id, pinned);
  }
}

/** Drop a cloud project's cached media, keeping pinned files. A copy left
 * empty loses its directory and its recency entry too. */
async function evictCachedCopy(id: string, pinned: Set<string>): Promise<number> {
  const dir = await mediaDir(id);
  if (!dir) return 0;
  const names: string[] = [];
  try {
    for await (const [name, handle] of dir) {
      if (handle.kind === "file") names.push(name);
    }
  } catch {
    return 0;
  }
  let freed = 0;
  let kept = 0;
  for (const name of names) {
    if (pinned.has(`${id}/${name}`)) {
      kept++;
      continue;
    }
    const size = (await readFileAt(dir, name))?.size ?? 0;
    revokeRegistered(mediaPath(id, name));
    try {
      await dir.removeEntry(name);
      freed += size;
    } catch {
      // Still held open somewhere; count nothing and move on.
    }
  }
  if (!kept) {
    await deleteProject(id).catch(() => {});
    await updateIndex((idx) => {
      delete idx.opens[id];
    }).catch(() => {});
  }
  return freed;
}
