"use client";

// Imports that are on screen before they are stored. A dropped file is probed
// from its own bytes and placed straight away; a stock tile or library clip is
// registered against its source URL. The copy into project storage runs here,
// behind the editor, and the asset swaps from the URL it arrived on to the
// stored one when the bytes land.
//
// Three things keep that honest:
// - Nothing about a pending asset reaches the saved document (see storedAssets
//   / docClips), so a tab that dies mid-upload leaves no broken reference.
// - Deleting a pending asset aborts its upload. A dropped file's claimed
//   object is never completed and is collected server-side; a remote copy
//   completes inside a single call, so one that lands after the asset is gone
//   is deleted here rather than left to count against the account.
// - A failed upload leaves the asset in place with an error, so the user can
//   retry it rather than discover later that it was never saved.
import { getBackend, type CutBackend } from "./backend";
import type { PendingImport } from "./media";
import { useEditor } from "./store";
import { mediaUrl } from "./types";

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

/** Retry an upload that failed. */
export function retryUpload(assetId: string) {
  const job = jobs.get(assetId);
  if (!job) return;
  job.controller = new AbortController();
  useEditor.getState().updateAsset(assetId, { upload: { progress: 0 } });
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
  URL.revokeObjectURL(job.pending.localUrl);
}

/** An upload is only worth finishing while its asset is still open in front of
 * the user: deleting it, or leaving for another project, ends it. */
function wanted(job: Job): boolean {
  const s = useEditor.getState();
  return s.projectId === job.projectId && s.assets.some((a) => a.id === job.pending.asset.id);
}

async function run(job: Job) {
  const { asset, localUrl, send } = job.pending;
  await acquire();
  try {
    if (!wanted(job)) return cancelUpload(asset.id);
    let shown = -1;
    const fileName = await send({
      signal: job.controller.signal,
      onProgress: (fraction) => {
        // The progress stream is the cheapest place to notice the asset is
        // gone, and the only one that fires during a long upload.
        if (!wanted(job)) return cancelUpload(asset.id);
        const pct = Math.floor(fraction * 100);
        if (pct === shown) return;
        shown = pct;
        useEditor.getState().updateAsset(asset.id, { upload: { progress: fraction } });
      },
    });
    if (!wanted(job)) {
      // The bytes beat the cancel: they are stored and counted, and nothing
      // in the document points at them any more.
      cancelUpload(asset.id);
      return dropLanded(job, fileName);
    }
    jobs.delete(asset.id);
    // The stored file takes over from the source bytes, under the name the
    // copy resolved to (a dropped file reserved it up front; a remote import
    // learns it here). Filmstrips are self-contained frames and survive the
    // swap; a still's single "frame" is the source itself, so it repoints
    // with the asset.
    const url = mediaUrl(job.projectId, fileName);
    useEditor.getState().updateAsset(asset.id, {
      fileName,
      url,
      upload: undefined,
      ...(asset.type === "image" ? { thumbs: [url] } : {}),
    });
    // Decoders repoint on the URL change; let the frame they are painting
    // finish before the bytes behind them go away.
    setTimeout(() => URL.revokeObjectURL(localUrl), 10_000);
  } catch (err) {
    if (job.controller.signal.aborted) return;
    if (!wanted(job)) return cancelUpload(asset.id);
    useEditor.getState().updateAsset(asset.id, {
      upload: { progress: 0, error: err instanceof Error ? err.message : "Upload failed." },
    });
  } finally {
    release();
  }
}
