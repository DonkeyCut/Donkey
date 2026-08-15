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
// The cache side runs the other way: media that hydrated over a signed URL is
// streamed into the store in the background, so the next open of the same
// project on this machine plays from disk.
//
// Every function is a no-op wherever the browser can't hold a store, so call
// sites stay unconditional.
import {
  askPersist,
  deleteMedia,
  deleteProject,
  mediaDir,
  readFileAt,
  readIndex,
  saveMedia,
  supportsBrowserStore,
  updateIndex,
  writeFileAt,
  type PendingUpload,
} from "./backend/browser/opfs";
import { registerBlobFile, registeredUrl, revokeRegistered } from "./backend/browser/registry";

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

/** A media delete's local half: the file, its blob URL, and its pin. */
export async function dropLocalMedia(projectId: string, fileName: string): Promise<void> {
  if (!supportsBrowserStore()) return;
  revokeRegistered(mediaPath(projectId, fileName));
  await deleteMedia(projectId, fileName).catch(() => {});
  await clearPendingUpload(projectId, fileName);
}

/** A project delete's local half: its whole subtree, URLs, and pins. */
export async function dropLocalProjectCopy(projectId: string): Promise<void> {
  if (!supportsBrowserStore()) return;
  revokeRegistered(`/api/cut/projects/${projectId}/`);
  await deleteProject(projectId).catch(() => {});
  try {
    await updateIndex((idx) => {
      idx.pendingUploads = idx.pendingUploads.filter((p) => p.projectId !== projectId);
    });
  } catch {
    // Orphaned pins for a gone project are swept on the next open attempt.
  }
}

const caching = new Set<string>();

/** Cache-on-read: stream a signed URL's bytes into the store in the
 * background, so the next open of this project plays the file from disk.
 * Fire-and-forget; a failed or refused write costs nothing but the cache. */
export function cacheCloudMedia(projectId: string, fileName: string, url: string): void {
  if (!supportsBrowserStore()) return;
  const path = mediaPath(projectId, fileName);
  if (registeredUrl(path) || caching.has(path)) return;
  caching.add(path);
  void (async () => {
    try {
      if (await localMediaFile(projectId, fileName)) return;
      const res = await fetch(url);
      if (!res.ok) return;
      const blob = await res.blob();
      const dir = await mediaDir(projectId, true);
      if (!dir) return;
      await writeFileAt(dir, fileName, blob);
    } catch {
      // Out of space or offline mid-stream: the abort discards the partial
      // write, and signed URLs keep the project playing.
    } finally {
      caching.delete(path);
    }
  })();
}
