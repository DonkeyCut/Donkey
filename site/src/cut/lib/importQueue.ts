"use client";

// Imports that are on screen before they are stored. A dropped file is probed
// from its own bytes and placed straight away; a stock tile or library clip is
// registered against its source URL. The copy into project storage runs here,
// behind the editor, and the asset swaps from the URL it arrived on to the
// stored one when the bytes land.
//
// A pending upload lives in one of two worlds, and its lifecycle follows:
// - Tab-scoped (`upload.stored` unset): the bytes exist only in this tab, so
//   nothing about the asset reaches the saved document (see storedAssets /
//   docClips) and leaving the project cancels the upload — a copy that lands
//   after the cancel is deleted so it never counts against the account.
// - Store-backed (`upload.stored`): the browser store holds the bytes and the
//   document already references the asset, so the upload is background sync.
//   Deleting the asset cancels it (removeAsset cleans both sides), but leaving
//   the project only pauses it — the ledger pin resumes it on the next open,
//   and bytes that land late stay landed, because the document points at them.
// - Either way a failed upload leaves the asset in place with an error, so the
//   user can retry it rather than discover later that it was never saved.
import { getBackend, type CutBackend } from "./backend";
import { resolveRegisteredBlob } from "./backend/browser/registry";
import type { PendingImport } from "./media";
import { localMediaUrl } from "./mediaSync";
import { useEditor } from "./store";
import { mediaUrl } from "./types";

/** Blob URLs owned by the browser store's registry stay alive for the whole
 * session; only tab-scoped object URLs are this queue's to revoke. */
function revokeTabUrl(url: string) {
  if (!resolveRegisteredBlob(url)) URL.revokeObjectURL(url);
}

// Browsers cap connections per host anyway; a small window keeps one big file
// from starving the rest of a multi-file drop.
const MAX_IN_FLIGHT = 3;

let active = 0;
const waiting: (() => void)[] = [];

function acquire(): Promise<void> {
  if (active < MAX_IN_FLIGHT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

type Job = {
  pending: PendingImport;
  projectId: string;
  /** Pinned at start: the copy can outlast a move to a project of the other
   * residency, and its cleanup has to reach the backend it landed on. */
  backend: CutBackend;
  controller: AbortController;
};

const jobs = new Map<string, Job>();

/** Start the background upload for a prepared import. The asset must already
 * be in the store. */
export function startUpload(projectId: string, pending: PendingImport) {
  const job: Job = {
    pending,
    projectId,
    backend: getBackend(),
    controller: new AbortController(),
  };
  jobs.set(pending.asset.id, job);
  void run(job);
}

/** Whether a job's bytes are held by the browser store — see the header. */
const storeBacked = (job: Job) => job.pending.asset.upload?.stored === true;

/** The `upload` patch for a job, keeping `stored` so a progress tick can't
 * demote a store-backed asset to tab-scoped (which would strip it from the
 * saved document). `updateAsset` merges shallowly; `upload` is replaced whole. */
function uploadPatch(job: Job, progress: number, error?: string) {
  return {
    upload: {
      progress,
      ...(error !== undefined ? { error } : {}),
      ...(storeBacked(job) ? { stored: true as const } : {}),
    },
  };
}

/** Retry an upload that failed. */
export function retryUpload(assetId: string) {
  const job = jobs.get(assetId);
  if (!job) return;
  job.controller = new AbortController();
  useEditor.getState().updateAsset(assetId, uploadPatch(job, 0));
  void run(job);
}

/** Drop bytes that landed for an asset that is no longer here. A copy that
 * completes counts against the account's storage, so a cancel that arrives
 * once it has finished has to take the file back out. */
function dropLanded(job: Job, fileName: string) {
  void job.backend
    .fetch(`/api/cut/projects/${job.projectId}/media/${encodeURIComponent(fileName)}`, {
      method: "DELETE",
    })
    .catch(() => {});
}

/** Stop an upload whose asset is gone. A claim the copy never completed is
 * left incomplete on purpose — it was never counted against the account. */
export function cancelUpload(assetId: string) {
  const job = jobs.get(assetId);
  if (!job) return;
  jobs.delete(assetId);
  job.controller.abort();
  revokeTabUrl(job.pending.localUrl);
}

/** True while this asset's upload job is alive (in flight or failed-retryable). */
export function uploadInFlight(assetId: string): boolean {
  return jobs.has(assetId);
}

/** An upload is only worth finishing while its asset is still open in front of
 * the user: deleting it, or leaving for another project, ends it. A
 * store-backed upload outlives navigation on the ledger, so this gate only
 * applies to tab-scoped ones. */
function wanted(job: Job): boolean {
  const s = useEditor.getState();
  return s.projectId === job.projectId && s.assets.some((a) => a.id === job.pending.asset.id);
}

/** Set a store-backed upload down without unpinning it: the ledger entry and
 * the stored bytes stay, and the next open of the project resumes the drain. */
function pauseUpload(job: Job) {
  jobs.delete(job.pending.asset.id);
  job.controller.abort();
}

/** A store-backed job that lost its asset: leaving the project pauses it;
 * deleting the asset ends it (removeAsset already cleaned the store side). */
function stopStored(job: Job) {
  if (useEditor.getState().projectId === job.projectId) cancelUpload(job.pending.asset.id);
  else pauseUpload(job);
}

async function run(job: Job) {
  const { asset, localUrl, send } = job.pending;
  const stored = storeBacked(job);
  await acquire();
  try {
    if (!wanted(job)) return stored ? stopStored(job) : cancelUpload(asset.id);
    let shown = -1;
    const fileName = await send({
      signal: job.controller.signal,
      onProgress: (fraction) => {
        // The progress stream is the cheapest place to notice the asset is
        // gone, and the only one that fires during a long upload.
        if (!wanted(job)) return stored ? stopStored(job) : cancelUpload(asset.id);
        const pct = Math.floor(fraction * 100);
        if (pct === shown) return;
        shown = pct;
        useEditor.getState().updateAsset(asset.id, uploadPatch(job, fraction));
      },
    });
    if (!wanted(job)) {
      if (stored) {
        // The bytes landed exactly where the saved document points; the job
        // is simply finished, in whatever project the user is in now.
        jobs.delete(asset.id);
        return;
      }
      // The bytes beat the cancel: they are stored and counted, and nothing
      // in the document points at them any more.
      cancelUpload(asset.id);
      return dropLanded(job, fileName);
    }
    jobs.delete(asset.id);
    // The stored file takes over from the source bytes, under the name the
    // copy resolved to (a dropped file reserved it up front; a remote import
    // learns it here). When the browser store holds the bytes the asset keeps
    // playing from disk; otherwise it moves to the backend URL. Filmstrips
    // are self-contained frames and survive the swap; a still's single
    // "frame" is the source itself, so it repoints with the asset.
    const url = (await localMediaUrl(job.projectId, fileName)) ?? mediaUrl(job.projectId, fileName);
    useEditor.getState().updateAsset(asset.id, {
      fileName,
      url,
      upload: undefined,
      ...(asset.type === "image" ? { thumbs: [url] } : {}),
    });
    // The stored file's route URL redirects to a freshly signed link on every
    // read. Mint it now so the asset settles on the media origin — which the
    // chunk cache keeps and a playing clip reads straight from — instead of
    // being repointed a second time at the next scheduled mint.
    void import("./mediaLinks")
      .then((m) => m.refreshSignedUrls(true))
      .catch(() => {});
    // Decoders repoint on the URL change; let the frame they are painting
    // finish before the bytes behind them go away.
    setTimeout(() => revokeTabUrl(localUrl), 10_000);
  } catch (err) {
    if (job.controller.signal.aborted) return;
    if ((err as { paused?: boolean }).paused) return pauseUpload(job);
    if (!wanted(job)) return stored ? stopStored(job) : cancelUpload(asset.id);
    useEditor.getState().updateAsset(
      asset.id,
      uploadPatch(job, 0, err instanceof Error ? err.message : "Upload failed.")
    );
  } finally {
    release();
  }
}
