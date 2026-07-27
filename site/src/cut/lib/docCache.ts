"use client";

/**
 * A project's own snapshots: the document the editor opens with, and the
 * signed links that make its media playable.
 *
 * Opening a cloud project is two round trips before a frame can be drawn —
 * fetch the doc, then mint a batch of R2 URLs for its files. Both answers are
 * things this browser already had the last time it held the project, so both
 * are kept on disk and painted immediately while the real ones are fetched.
 * The document snapshot is rewritten on every successful save, which makes it
 * a copy of what this browser itself last pushed to the server.
 *
 * The snapshot is a head start, never the truth: the live document always
 * lands and replaces it, and a project edited from another device simply
 * corrects itself a moment after it opens.
 */

import { getBackend } from "./backend";
import type { CutMode } from "./backend/types";
import { dropSnapshot, readSnapshot, snapshotKey, writeSnapshot } from "./cache";
import type { ProjectDoc } from "./types";

/** Reuse a stored batch only with this much life left, so a project opened on
 * a snapshot is never handed links that expire while it is being edited. */
const LINK_REUSE_FLOOR_MS = 10 * 60 * 1000;

const docKey = (projectId: string, kind: CutMode) => snapshotKey(kind, "doc", projectId);
const linksKey = (projectId: string, kind: CutMode) => snapshotKey(kind, "media-links", projectId);

export type CachedDoc = Partial<ProjectDoc>;

export function readCachedDoc(projectId: string, kind = getBackend().kind) {
  return readSnapshot<CachedDoc>(docKey(projectId, kind));
}

export function writeCachedDoc(projectId: string, doc: CachedDoc, kind = getBackend().kind) {
  writeSnapshot(docKey(projectId, kind), doc);
}

export function dropCachedDoc(projectId: string, kind = getBackend().kind) {
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
export function seedNewProjectDoc(projectId: string, name: string, kind: CutMode) {
  writeCachedDoc(
    projectId,
    {
      name,
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
