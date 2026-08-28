// The blob-URL registry: the synchronous face of the browser store.
//
// `backend.url()` must answer without awaiting, and OPFS reads can't. The
// store closes that gap by registering every file it serves under its API
// path — the same `/api/cut/projects/:id/media/:file` string every call site
// already builds — and minting one blob URL per file. `url()` becomes a map
// lookup, media elements consume the blob URL natively, and decoders skip the
// URL entirely: `openMedia` resolves the backing File here and reads it as a
// Blob, because ranged fetches of blob URLs are unreliable across browsers.
//
// Blob URLs are session-scoped by nature, so nothing here persists: a reload
// re-registers from OPFS during hydration. Registration is idempotent per
// path — re-registering the same path revokes the old URL first, and dropping
// a project revokes everything under its path prefix.

type Entry = { url: string; file: File };

const byPath = new Map<string, Entry>();
const byUrl = new Map<string, File>();

/** Mint (or re-mint) the blob URL for a store file at its API path. */
export function registerBlobFile(path: string, file: File): string {
  const prior = byPath.get(path);
  if (prior) {
    byUrl.delete(prior.url);
    URL.revokeObjectURL(prior.url);
  }
  const url = URL.createObjectURL(file);
  byPath.set(path, { url, file });
  byUrl.set(url, file);
  return url;
}

/** The minted URL for an API path, when its file has been registered. */
export function registeredUrl(path: string): string | null {
  return byPath.get(path)?.url ?? null;
}

/** The backing File of a minted blob URL — decoders read this directly
 * instead of fetching the URL. Null for URLs the store didn't mint. */
export function resolveRegisteredBlob(url: string): File | null {
  return byUrl.get(url) ?? null;
}

// An in-tab render reads its project's files through these URLs for as long
// as it runs, and it survives the user opening another project — which is
// exactly when the store revokes the subtree. A hold keeps the URLs alive for
// the render; the revoke waits and lands when the last hold releases.
const holds = new Map<string, number>();
const deferred = new Set<string>();

function held(prefix: string): boolean {
  for (const h of holds.keys()) {
    if (h.startsWith(prefix) || prefix.startsWith(h)) return true;
  }
  return false;
}

/** Keep every registration under `prefix` alive until the matching release. */
export function holdRegistered(prefix: string): void {
  holds.set(prefix, (holds.get(prefix) ?? 0) + 1);
}

/** Release a hold and land any revokes that waited on it. */
export function releaseRegistered(prefix: string): void {
  const n = (holds.get(prefix) ?? 0) - 1;
  if (n > 0) holds.set(prefix, n);
  else holds.delete(prefix);
  for (const d of deferred) {
    if (held(d)) continue;
    deferred.delete(d);
    sweep(d);
  }
}

function sweep(prefix: string): void {
  for (const [path, entry] of byPath) {
    if (!path.startsWith(prefix)) continue;
    byPath.delete(path);
    byUrl.delete(entry.url);
    URL.revokeObjectURL(entry.url);
  }
}

/** Forget one registration now. Its blob URL failed to read — the File behind
 * it no longer serves anything, held or not — so the next ask for the path
 * mints afresh from what the store holds. */
export function forgetRegistered(path: string): void {
  const entry = byPath.get(path);
  if (!entry) return;
  byPath.delete(path);
  byUrl.delete(entry.url);
  URL.revokeObjectURL(entry.url);
}

/** A subtree coming back into use (its project re-opened while a hold kept it
 * alive): a revoke still waiting on it no longer applies. */
export function cancelRevoke(prefix: string): void {
  deferred.delete(prefix);
}

/** Revoke every registration whose API path starts with `prefix` (a closed or
 * deleted project's subtree). A held subtree revokes when its hold releases. */
export function revokeRegistered(prefix: string): void {
  if (held(prefix)) {
    deferred.add(prefix);
    return;
  }
  sweep(prefix);
}
