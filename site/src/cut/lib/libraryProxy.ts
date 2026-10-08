"use client";

// The playable copy of a library video the browser cannot decode.
//
// A ProRes master — a phone's or a camera's — has no decoder in any browser's
// media element, so a card of one shows nothing and its viewer plays only the
// sound. The shelf that holds the master builds a copy beside it with the
// project preview's proxy code (the Mac's engine, the cloud worker, or this
// page for the browser shelf) and names it on the asset; every surface then
// plays the copy, and a project still takes the master.
//
// A card asks the moment its own video element reports no picture, so the
// files already on a shelf heal the first time anyone looks at them, and
// whatever format a browser cannot show takes the same path.

import { create } from "zustand";
import { engineFeatures } from "./api";
import { apiJson } from "./backend";
import { pollCloudJob } from "./cloudJob";
import { cutColor } from "./colorSettings";
import type { LibraryAsset, LibraryData } from "./library";
import { useLightbox, lightboxItemFromLibrary } from "./lightbox";
import { backendFor } from "./residency";

/** Where an asset's copy stands this session. */
export type LibraryProxyState =
  | { kind: "making"; progress: number }
  | { kind: "failed"; error: string };

interface LibraryProxies {
  jobs: Record<string, LibraryProxyState>;
}

/** The copies being made, or found unmakeable, this session, by shelf and id. */
export const useLibraryProxies = create<LibraryProxies>(() => ({ jobs: {} }));

/** An asset's key in the store: ids are unique per shelf only. */
export const libraryProxyKey = (a: Pick<LibraryAsset, "id" | "residency">) => `${a.residency}:${a.id}`;

const setJob = (key: string, state: LibraryProxyState | null) =>
  useLibraryProxies.setState((s) => {
    const jobs = { ...s.jobs };
    if (state) jobs[key] = state;
    else delete jobs[key];
    return { jobs };
  });

const FAILED = "Could not make a playable copy of this video.";
/** A cloud build still queued when the poll gives up: the worker keeps going,
 * and the shelf's next listing carries the copy. */
const STILL_QUEUED = "The playable copy is still being made.";

/**
 * Have the asset's shelf build its playable copy, then write the copy onto
 * the cached listing and onto the viewer if it is showing this asset. Runs
 * once per asset per session: a second ask while one is on its way, or after
 * one failed, does nothing, so a file nothing can convert never loops.
 */
export async function ensureLibraryProxy(
  a: LibraryAsset,
  patch: (fn: (d: LibraryData) => LibraryData) => void
): Promise<void> {
  const key = libraryProxyKey(a);
  if (a.type !== "video" || a.proxyFile || useLibraryProxies.getState().jobs[key]) return;
  setJob(key, { kind: "making", progress: 0 });
  try {
    // A Mac app older than the route has nothing to build the copy with.
    if (a.residency === "local" && !(await engineFeatures()).has("library.proxy")) {
      throw new Error("Update the Donkey app to play this video here.");
    }
    const backend = backendFor(a.residency);
    const { proxyMaxHeight, proxyCrf } = cutColor();
    const res = await backend.fetch(`/api/cut/library/${encodeURIComponent(a.id)}/proxy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxHeight: proxyMaxHeight, crf: proxyCrf }),
    });
    const body = await apiJson<LibraryAsset | { jobId: string }>(res);
    if (!res.ok) throw new Error(body.error ?? FAILED);

    // The cloud queues the build on its worker; the Mac and the page answer
    // with the asset once the copy is there.
    const landed = "jobId" in body
      ? await pollCloudJob<LibraryAsset>(body.jobId, backend, FAILED, {
          timedOut: STILL_QUEUED,
          onProgress: (progress) => setJob(key, { kind: "making", progress }),
        })
      : body;
    const proxyFile = landed.proxyFile;
    if (!proxyFile) throw new Error(FAILED);
    const updated: LibraryAsset = { ...a, proxyFile };
    patch((d) => ({
      ...d,
      assets: d.assets.map((x) => (x.id === a.id && x.residency === a.residency ? { ...x, proxyFile } : x)),
    }));

    // A viewer open on this asset swaps to the copy.
    const open = useLightbox.getState().item;
    if (open?.libraryId === a.id) useLightbox.getState().open(lightboxItemFromLibrary(updated, open.bare));
    setJob(key, null);
  } catch (e) {
    const error = e instanceof Error ? e.message : FAILED;
    if (error === STILL_QUEUED) return;
    setJob(key, { kind: "failed", error });
  }
}
