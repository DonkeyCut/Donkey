"use client";

/**
 * Background writes to a project that is NOT open in the editor. A scene run
 * outlives the open project: when the user switches away, its placements,
 * assets, and plan keep landing in the project's persisted doc through this
 * serialized read-modify-write queue, and the editor picks everything up on
 * the next open. One promise chain per project, so concurrent shot placements
 * never interleave a read with another write; `docWriterIdle` lets a project
 * load wait out in-flight writes so an open never reads a half-written doc.
 *
 * The clip/audio placement helpers mirror the store's placeGenClip /
 * placeGenAudio semantics exactly (fillSlot, optional muting, lanes, volume) —
 * the doc is just the other end of the same contract.
 */

import { apiJson, getBackend, type CutBackend } from "../backend";
import { projectBackend } from "../residency";
import { RENDERS_CAP, storedAssets, useEditor } from "../store";
import { mediaUrl, SPEED_MIN } from "../types";
import type { AudioClip, MediaAsset, ProjectDoc, RenderRecord, VideoClip } from "../types";
import { fillSlot } from "./fillSlot";

const MIN_LEN = 0.1;
const uid = () => crypto.randomUUID().slice(0, 10);

const chains = new Map<string, Promise<void>>();

/** Queue one read-modify-write of a closed project's doc. Rejections reach the
 * caller; the chain itself always continues. */
export function withProjectDoc(
  projectId: string,
  mutate: (doc: ProjectDoc) => void,
  // Background writes can outlive navigation into a project of the other
  // residency; callers that know their backend pin it here.
  backend: CutBackend = getBackend()
): Promise<void> {
  const prev = chains.get(projectId) ?? Promise.resolve();
  const next = prev.then(async () => {
    const res = await backend.fetch(`/api/cut/projects/${projectId}`);
    const doc = await apiJson<ProjectDoc>(res);
    if (!res.ok) throw new Error(doc?.error ?? "Could not read the project.");
    mutate(doc);
    const put = await backend.fetch(`/api/cut/projects/${projectId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    });
    if (!put.ok) throw new Error("Could not save the project in the background.");
  });
  chains.set(projectId, next.catch(() => {}));
  return next;
}

/** Resolves once every queued background write for the project has settled —
 * the editor's project load awaits this so it never reads mid-write. The load
 * sets `projectId` (with `loaded` false) BEFORE awaiting, so a write that
 * hasn't queued yet routes through `projectWriteMode` and waits for the load
 * instead — between the two, no doc write can race the load's fetch. */
export function docWriterIdle(projectId: string): Promise<void> {
  return (chains.get(projectId) ?? Promise.resolve()).catch(() => {});
}

/** Where a background write for this project must land right now: the live
 * store when the project is open and loaded, its persisted doc otherwise. A
 * load in progress is waited out so a write never races the load's doc fetch —
 * it either queued before the load began (docWriterIdle drains it) or lands in
 * the store after. A failed load falls through to the doc: the store never
 * loaded, autosave never runs, so the doc stays the source of truth. */
export async function projectWriteMode(projectId: string): Promise<"store" | "doc"> {
  for (;;) {
    const s = useEditor.getState();
    if (s.projectId !== projectId) return "doc";
    if (s.loaded) return "store";
    if (s.loadError) return "doc";
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Register a run-created asset in a closed project's doc (the open-project
 * path stocks the store instead and autosave persists it). Idempotent. */
export function stockAssetInDoc(
  projectId: string,
  asset: MediaAsset,
  backend?: CutBackend
): Promise<void> {
  return withProjectDoc(
    projectId,
    (doc) => {
      if (!doc.assets.some((a) => a.id === asset.id)) {
        doc.assets.push(storedAssets([asset])[0]);
      }
    },
    backend
  );
}

/** Mirror a chat-launched render's record into a closed project's doc (the
 * open-project path writes the store and autosave persists it). */
export function upsertRenderInDoc(
  projectId: string,
  record: RenderRecord,
  backend?: CutBackend
): Promise<void> {
  return withProjectDoc(
    projectId,
    (doc) => {
      const rest = (doc.renders ?? []).filter((r) => r.id !== record.id);
      doc.renders = [...rest, record].slice(-RENDERS_CAP);
    },
    backend
  );
}

/** Drop render records from a closed project's doc (dismissed or owner gone). */
export function removeRendersInDoc(
  projectId: string,
  ids: string[],
  backend?: CutBackend
): Promise<void> {
  return withProjectDoc(
    projectId,
    (doc) => {
      doc.renders = (doc.renders ?? []).filter((r) => !ids.includes(r.id));
    },
    backend
  );
}

/** A run's asset by id, wherever the user is: the live store when the run's
 * project is open, its persisted doc when not. The doc projection is rebuilt
 * into a usable runtime asset (url from the media route). */
export async function findRunAsset(
  projectId: string,
  assetId: string
): Promise<MediaAsset | undefined> {
  const s = useEditor.getState();
  if (s.projectId === projectId) {
    const live = s.assets.find((a) => a.id === assetId);
    if (live) return live;
  }
  // The project's own backend, not the ambient one: a run whose project the
  // user navigated away from would otherwise ask the engine for a cloud
  // project's doc (or the reverse) and lose its identity anchors silently.
  const backend = await projectBackend(projectId);
  const res = await backend.fetch(`/api/cut/projects/${projectId}`);
  const doc = await apiJson<ProjectDoc>(res);
  if (!res.ok) return undefined;
  const stored = doc.assets.find((a) => a.id === assetId);
  return stored ? { ...stored, url: mediaUrl(projectId, stored.fileName, backend) } : undefined;
}

/** placeGenClip against a doc: fill [startSec, endSec) exactly on track 0,
 * honoring the reviewer's source window. Muted only when asked (a provided-audio
 * scene mutes its b-roll; a generated scene keeps the burned-in narration
 * audible). Returns the new clip id. */
export function docPlaceGenClip(
  doc: ProjectDoc,
  assetId: string,
  startSec: number,
  endSec: number,
  srcInSec?: number,
  muted = true
): string | null {
  const asset = doc.assets.find((a) => a.id === assetId);
  if (!asset || (asset.type !== "video" && asset.type !== "image")) return null;
  const slot = Math.max(MIN_LEN, endSec - startSec);
  const srcIn =
    asset.type === "video"
      ? Math.min(Math.max(0, srcInSec ?? 0), Math.max(0, asset.duration - slot))
      : 0;
  const { out, speed } = fillSlot(asset.type, Math.max(MIN_LEN, asset.duration - srcIn), slot, SPEED_MIN);
  const clip: VideoClip = {
    id: uid(),
    assetId,
    track: 0,
    start: Math.max(0, startSec),
    in: srcIn,
    out: srcIn + out,
    muted,
    ...(speed !== undefined ? { speed } : {}),
  };
  doc.clips = [...doc.clips, clip].sort((a, b) => a.start - b.start);
  return clip.id;
}

/** placeGenAudio against a doc — voiceover or music bed, ducked, on a lane, at
 * an optional baseline volume (a music bed sits under the burned-in narration). */
export function docPlaceGenAudio(
  doc: ProjectDoc,
  assetId: string,
  startSec: number,
  durSec: number,
  opts?: { duck?: number; lane?: number; volume?: number }
): string | null {
  const asset = doc.assets.find((a) => a.id === assetId);
  if (!asset || asset.type !== "audio") return null;
  const out = Math.min(asset.duration, Math.max(MIN_LEN, durSec));
  const lane = opts?.lane ?? 0;
  const clip: AudioClip = {
    id: uid(),
    assetId,
    start: Math.max(0, startSec),
    in: 0,
    out,
    volume: opts?.volume ?? 1,
    ...(opts?.duck !== undefined && opts.duck < 1 ? { duck: Math.max(0, opts.duck) } : {}),
    ...(lane > 0 ? { lane } : {}),
  };
  doc.audioClips = [...doc.audioClips, clip];
  return clip.id;
}
