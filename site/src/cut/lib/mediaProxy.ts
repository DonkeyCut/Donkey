"use client";

/**
 * The preview proxy of a ProRes master.
 *
 * A ProRes file has no hardware decoder in any browser. The master stays in
 * the project — an export reads it — and beside it lands a 10-bit HEVC (or
 * AV1, or VP9) proxy the preview plays at speed (server/proxy.ts says what
 * the file is). Until the proxy lands, and wherever none can be made, the
 * preview decodes the master through the WASM decoder: slower, and the
 * same picture.
 *
 * Who builds it follows the residency: the engine for a project on this Mac,
 * the worker for a cloud project, and for a browser project the page itself
 * when it has a 10-bit encoder, else the Mac's engine when the app is there
 * and carries the route, else nobody — the one fallback, shown in the panel.
 * The result always lands in the project's own storage and is written onto
 * the asset through the store.
 */

import { create } from "zustand";
import { engineFeatures } from "./api";
import { getBackend, type CutBackend } from "./backend";
import { mediaDir } from "./backend/browser/opfs";
import { resolveRegisteredBlob } from "./backend/browser/registry";
import { pollCloudJob } from "./cloudJob";
import { cutColor } from "./colorSettings";
import { uploadProjectMediaTo } from "./media";
import { frameSinkIsCustom, probeMediaFile } from "./mediaRead";
import { forgetLocalMediaUrl, storedMediaUrl } from "./mediaSync";
import { encodeProxyInPage, proxyNameFor, proxyOnTheMac, type Landed } from "./proxyEncode";
import { useEditor } from "./store";
import type { MediaAsset, StoredAsset } from "./types";

/** A video whose master needs a proxy and has none: ProRes (a four-character
 * code starting `ap`), read off the header at import. */
export function needsProxy(asset: Pick<StoredAsset, "type" | "color" | "proxy" | "block">): boolean {
  return asset.type === "video" && !asset.proxy && !asset.block && !!asset.color?.codec?.startsWith("ap");
}

/** What the panel shows about an asset's proxy. */
export type ProxyState =
  | { kind: "making"; progress: number }
  /** No residency could make one; the preview plays the master. */
  | { kind: "none" }
  | { kind: "failed"; error: string };

interface ProxyJobs {
  jobs: Record<string, ProxyState>;
  set: (assetId: string, state: ProxyState | null) => void;
}

/** The proxies being made, or found unmakeable, this session, by asset id. */
export const useProxyJobs = create<ProxyJobs>((set) => ({
  jobs: {},
  set: (assetId, state) =>
    set((s) => {
      const jobs = { ...s.jobs };
      if (state) jobs[assetId] = state;
      else delete jobs[assetId];
      return { jobs };
    }),
}));

const inFlight = new Set<string>();

/**
 * Make sure the asset has a proxy: build one through the residency that can,
 * and write it onto the asset. Runs once per asset at a time; a second ask
 * while one is on its way does nothing. A failure leaves the asset on the
 * master and says so in the panel.
 */
export async function ensureProxy(
  projectId: string,
  asset: MediaAsset,
  backend: CutBackend = getBackend()
): Promise<void> {
  // A proxy is for the screen. A headless runner draws for a render or a
  // chat tool and reads the master; the page queues the proxy when the
  // project is next opened.
  if (frameSinkIsCustom()) return;
  if (!needsProxy(asset) || asset.upload || inFlight.has(asset.id)) return;
  inFlight.add(asset.id);
  const jobs = useProxyJobs.getState();
  const progress = (p: number) => jobs.set(asset.id, { kind: "making", progress: Math.max(0, Math.min(1, p)) });
  progress(0);
  try {
    const landed = await buildProxy(projectId, asset, backend, progress);
    if (!landed) {
      jobs.set(asset.id, { kind: "none" });
      return;
    }
    const proxyUrl = await storedMediaUrl(projectId, landed.fileName, backend);
    useEditor.getState().setAssetProxy(asset.id, { fileName: landed.fileName, sizeBytes: landed.sizeBytes }, proxyUrl);
    jobs.set(asset.id, null);
  } catch (e) {
    jobs.set(asset.id, { kind: "failed", error: e instanceof Error ? e.message : "Could not make the preview proxy." });
  } finally {
    inFlight.delete(asset.id);
  }
}

const healing = new Set<string>();

/**
 * A reader could not open the asset's proxy. The proxy comes off the asset at
 * once, so every reader plays the master, and the project heals it once per
 * session: the stored file comes back under a fresh address when it still
 * reads (a lapsed link), and otherwise `ensureProxy` makes a new one.
 */
export async function proxyUnreadable(asset: MediaAsset, backend: CutBackend = getBackend()): Promise<void> {
  const s = useEditor.getState();
  const live = s.assets.find((a) => a.id === asset.id);
  // Dropped or replaced since the reader tried it.
  if (!live?.proxy || live.proxyUrl !== asset.proxyUrl) return;
  const broken = live.proxy;
  s.dropAssetProxy(asset.id);
  const projectId = s.projectId;
  if (!projectId || s.readOnly || frameSinkIsCustom()) return;
  const key = `${projectId}:${asset.id}`;
  if (healing.has(key)) return;
  healing.add(key);
  const stillOpen = () => useEditor.getState().projectId === projectId;
  try {
    forgetLocalMediaUrl(projectId, broken.fileName);
    const url = await storedMediaUrl(projectId, broken.fileName, backend);
    if ((await probeMediaFile(url)).hasVideo) {
      if (stillOpen()) useEditor.getState().setAssetProxy(asset.id, broken, url);
      return;
    }
  } catch {
    // The file is gone or unreadable: build a new one.
  }
  const now = stillOpen() ? useEditor.getState().assets.find((a) => a.id === asset.id) : undefined;
  if (now) await ensureProxy(projectId, now, backend);
}

/** Every asset in the open project that still needs a proxy. */
export function ensureProjectProxies(): void {
  const s = useEditor.getState();
  if (!s.projectId || s.readOnly) return;
  for (const asset of s.assets) if (needsProxy(asset)) void ensureProxy(s.projectId, asset);
}

async function buildProxy(
  projectId: string,
  asset: MediaAsset,
  backend: CutBackend,
  onProgress: (p: number) => void
): Promise<Landed | null> {
  const { proxyMaxHeight, proxyCrf } = cutColor();
  if (backend.kind === "local") {
    if (!(await engineFeatures()).has("media.proxy")) return null;
    const res = await backend.fetch(`/api/cut/projects/${projectId}/proxy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: asset.fileName, maxHeight: proxyMaxHeight, crf: proxyCrf }),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<Landed> & { error?: string };
    if (!res.ok || !body.fileName || typeof body.sizeBytes !== "number") {
      throw new Error(body.error ?? "Could not make the preview proxy.");
    }
    return { fileName: body.fileName, sizeBytes: body.sizeBytes };
  }
  if (backend.kind === "cloud") {
    const res = await backend.fetch(`/api/cut/projects/${projectId}/proxy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: asset.fileName }),
    });
    const started = (await res.json().catch(() => ({}))) as Partial<Landed> & { jobId?: string; error?: string };
    if (!res.ok) throw new Error(started.error ?? "Could not make the preview proxy.");
    // A proxy already built answers with the file itself.
    if (started.fileName && typeof started.sizeBytes === "number") {
      return { fileName: started.fileName, sizeBytes: started.sizeBytes };
    }
    if (!started.jobId) throw new Error(started.error ?? "Could not make the preview proxy.");
    const result = await pollCloudJob<Partial<Landed>>(started.jobId, backend, "Could not make the preview proxy.", {
      timedOut: "The preview proxy took too long.",
      onProgress,
    });
    if (!result.fileName || typeof result.sizeBytes !== "number") throw new Error("Could not make the preview proxy.");
    return { fileName: result.fileName, sizeBytes: result.sizeBytes };
  }
  // A browser project: the page first, writing straight into the project's
  // storage, then the Mac beside it.
  const inPage = await proxyInPage(projectId, asset, proxyMaxHeight, onProgress);
  if (inPage) return inPage;
  const master = async () => resolveRegisteredBlob(asset.url) ?? (await (await fetch(asset.url)).blob());
  const blob = await proxyOnTheMac(master, asset.fileName, proxyMaxHeight, proxyCrf);
  if (!blob) return null;
  const fileName = await uploadProjectMediaTo(backend, projectId, blob, proxyNameFor(asset.fileName));
  return { fileName, sizeBytes: blob.size };
}

/** Build the project's proxy in this page, straight into its own storage. */
async function proxyInPage(
  projectId: string,
  asset: MediaAsset,
  maxHeight: number,
  onProgress: (p: number) => void
): Promise<Landed | null> {
  const dir = await mediaDir(projectId, true);
  if (!dir) return null;
  const from = { matrix: asset.color?.matrix ?? "bt709", fullRange: asset.color?.fullRange ?? false } as const;
  return encodeProxyInPage(asset.url, from, dir, asset.fileName, maxHeight, onProgress);
}
