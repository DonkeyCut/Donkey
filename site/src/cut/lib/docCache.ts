"use client";

/**
 * A project's own snapshots: the document the editor opens with, and the
 * signed links that make its media playable.
 *
 * Opening a cloud project is two round trips before a frame can be drawn —
 * fetch the doc, then mint a batch of R2 URLs for its files. Both answers are
 * things this browser already had the last time it held the project, so both
 * are kept on disk and painted immediately while the real ones are fetched.
 *
 * The document snapshot is also the editor's crash ledger: every edit rewrites
 * it marked dirty, alongside the version it was edited on top of, and a
 * successful save rewrites it clean. A snapshot that is clean is a head start
 * and never the truth — the live document lands and replaces it. A snapshot
 * that is dirty is unsaved work: the open resumes it and pushes it up, unless
 * the server has moved past its base version, in which case the server wins
 * like any conflict.
 */

import { getBackend } from "./backend";
import type { CutMode } from "./backend/types";
import { dropSnapshot, readSnapshot, snapshotKey, writeSnapshot } from "./cache";
import type { Aspect, ProjectDoc } from "./types";

/** Reuse a stored batch only with this much life left, so a project opened on
 * a snapshot is never handed links that expire while it is being edited. */
const LINK_REUSE_FLOOR_MS = 10 * 60 * 1000;

const docKey = (projectId: string, kind: CutMode) => snapshotKey(kind, "doc", projectId);
const linksKey = (projectId: string, kind: CutMode) => snapshotKey(kind, "media-links", projectId);

export type CachedDoc = Partial<ProjectDoc>;

/** On-disk shape. Older records stored the bare doc; both read back. */
type StoredDoc = { doc: CachedDoc; dirty?: boolean; baseVersion?: string | null };

export type CachedDocHit = {
  doc: CachedDoc;
  at: number;
  /** Edits the server never acknowledged. */
  dirty: boolean;
  /** The doc version the dirty edits were made on top of; null for a local
   * project (the engine has no versions) or edits made before one was known. */
  baseVersion: string | null;
};

export async function readCachedDoc(
  projectId: string,
  kind = getBackend().kind
): Promise<CachedDocHit | null> {
  const hit = await readSnapshot<StoredDoc | CachedDoc>(docKey(projectId, kind));
  if (!hit) return null;
  const v = hit.value as StoredDoc;
  if (v && typeof v === "object" && "doc" in v && v.doc && typeof v.doc === "object") {
    return { doc: v.doc, at: hit.at, dirty: v.dirty === true, baseVersion: v.baseVersion ?? null };
  }
  return { doc: hit.value as CachedDoc, at: hit.at, dirty: false, baseVersion: null };
}

// A drag can commit dozens of states a second; dirty writes trail-coalesce so
// the disk sees the latest state a beat later instead of every intermediate
// one. Clean writes land immediately and cancel whatever is pending — a save
// that succeeded must not be re-marked dirty by a write it already covers.
const DIRTY_WRITE_DELAY_MS = 150;
const dirtyPending = new Map<string, StoredDoc>();
const dirtyTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelDirtyWrite(key: string) {
  const timer = dirtyTimers.get(key);
  if (timer) clearTimeout(timer);
  dirtyTimers.delete(key);
  dirtyPending.delete(key);
}

function flushDirtyWrite(key: string) {
  const value = dirtyPending.get(key);
  cancelDirtyWrite(key);
  if (value) writeSnapshot(key, value);
}

export function writeCachedDoc(projectId: string, doc: CachedDoc, kind = getBackend().kind) {
  const key = docKey(projectId, kind);
  cancelDirtyWrite(key);
  writeSnapshot(key, { doc } satisfies StoredDoc);
}

export function writeCachedDocDirty(
  projectId: string,
  doc: CachedDoc,
  baseVersion: string | null,
  kind = getBackend().kind
) {
  const key = docKey(projectId, kind);
  dirtyPending.set(key, { doc, dirty: true, baseVersion } satisfies StoredDoc);
  if (!dirtyTimers.has(key)) {
    dirtyTimers.set(key, setTimeout(() => flushDirtyWrite(key), DIRTY_WRITE_DELAY_MS));
  }
}

/** Land every pending dirty write now — the page is going away, or the editor
 * is closing and its coalescing timers are about to be torn down. */
export function flushCachedDocWrites() {
  for (const key of [...dirtyTimers.keys()]) flushDirtyWrite(key);
}

export function dropCachedDoc(projectId: string, kind = getBackend().kind) {
  cancelDirtyWrite(docKey(projectId, kind));
  dropSnapshot(docKey(projectId, kind));
  dropSnapshot(linksKey(projectId, kind));
}

type StoredLinks = { urls: [string, string][]; expiresAt: number };

/** The stored signed batch, when it still covers every file the project holds
 * and has comfortable life left. Anything less returns null and the caller
 * mints a fresh batch, which is what it did before this cache existed. */
export async function readCachedMediaLinks(
  projectId: string,
  fileNames: string[]
): Promise<{ urls: Map<string, string>; expiresAt: number } | null> {
  const hit = await readSnapshot<StoredLinks>(linksKey(projectId, getBackend().kind));
  if (!hit) return null;
  const { urls, expiresAt } = hit.value;
  if (expiresAt - Date.now() < LINK_REUSE_FLOOR_MS) return null;
  const map = new Map(urls);
  if (fileNames.some((f) => !map.has(f))) return null;
  return { urls: map, expiresAt };
}

export function writeCachedMediaLinks(
  projectId: string,
  urls: Map<string, string>,
  expiresAt: number | null
) {
  if (expiresAt === null || urls.size === 0) {
    dropSnapshot(linksKey(projectId, getBackend().kind));
    return;
  }
  writeSnapshot(linksKey(projectId, getBackend().kind), {
    urls: [...urls],
    expiresAt,
  } satisfies StoredLinks);
}

/** The document a project has the instant it is created: a name and nothing
 * else. Seeding it lets the editor the user is about to land in open on the
 * first frame instead of waiting out a round trip for a document we can
 * already describe in full. */
export function seedNewProjectDoc(
  projectId: string,
  name: string,
  kind: CutMode,
  aspect?: Aspect
) {
  writeCachedDoc(
    projectId,
    {
      name,
      ...(aspect ? { aspect } : {}),
      assets: [],
      clips: [],
      audioClips: [],
      overlays: [],
      templates: [],
      renders: [],
    },
    kind
  );
}
