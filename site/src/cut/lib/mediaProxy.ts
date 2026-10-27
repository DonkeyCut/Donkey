"use client";

/**
 * The preview proxy of a ProRes master, or of a heavy video streamed from the
 * cloud.
 *
 * A ProRes file has no hardware decoder in any browser. The master stays in
 * the project — an export reads it — and beside it lands a 10-bit HEVC (or
 * AV1, or VP9) proxy the preview plays at speed (server/proxy.ts says what
 * the file is). Until the proxy lands, and wherever none can be made, the
 * preview decodes the master through the WASM decoder: slower, and the
 * same picture.
 *
 * A cloud project streams its media, and a fast cut opens a new file at every
 * cut: a 4K or high-bitrate master takes longer to reach its frame than a
 * half-second shot lasts, so the preview stalls at each one. Such a video
 * gets a proxy too, no taller than 1080p, built by the worker. A project on
 * this machine reads its files off its own disk and keeps its masters.
 *
 * Who builds it follows the residency: the engine for a project on this Mac,
 * the worker for a cloud project, and for a browser project the page itself
 * when it has a 10-bit encoder, else the Mac's engine when the app is there
 * and carries the route, else nobody — the one fallback, shown in the panel.
 * The result always lands in the project's own storage and is written onto
 * the asset through the store.
 *
 * A browser that cannot decode a master's H.264 or AAC gets the compat proxy
 * in the same slot (proxyNames.ts), from the engine, the worker, or for a
 * browser project the Mac or the worker by way of the cloud shelf. The page's
 * readers of that stream then open the proxy (mediaRead.ts `coveredSrc`).
 */

import { create } from "zustand";
import { engineFeatures } from "./api";
import { getBackend, type CutBackend } from "./backend";
import { mediaDir } from "./backend/browser/opfs";
import { resolveRegisteredBlob } from "./backend/browser/registry";
import { pollCloudJob } from "./cloudJob";
import { compatInTheCloud } from "./cloudLibraryUpload";
import { compatNeedOf } from "./codecSupport";
import { CUT_COLOR } from "./colorSettings";
import { enrichAsset, uploadProjectMediaTo } from "./media";
import { frameSinkIsCustom, hasUndecodableVideo, probeMediaFile, setStreamCovers, withMedia } from "./mediaRead";
import { forgetLocalMediaUrl, storedMediaUrl } from "./mediaSync";
import { encodeProxyInPage, proxyNameFor, proxyOnTheMac, type Landed } from "./proxyEncode";
import { compatCoverOf, compatCovers, compatProxyNameFor, isLightProxyName, type CompatCover } from "./proxyNames";
import { releaseProxyHold, useEditor } from "./store";
import type { MediaAsset, StoredAsset } from "./types";
import { errorFields, errorFromBody, UserError, type ErrorFields } from "./userError";

/** Past this many pixels a frame is heavier than 1080p (a 2048×1080 DCI
 * frame is not). */
export const HEAVY_PIXELS = 1920 * 1080 * 1.1;
/** Past this average bitrate a master streams slower than a fast cut plays. */
export const HEAVY_BITS_PER_SECOND = 12_000_000;
/** The tallest proxy a heavy video gets: the stage is never larger. */
export const HEAVY_PROXY_MAX_HEIGHT = 1080;

type ProxyFacts = Pick<StoredAsset, "type" | "color" | "proxy" | "block" | "width" | "height" | "sizeBytes" | "duration">;

/** ProRes, by the four-character code read off the header at import. */
const isProres = (asset: Pick<StoredAsset, "color">) => !!asset.color?.codec?.startsWith("ap");

/** A video too large or too dense to stream at a fast cut's pace. */
export function isHeavyVideo(asset: ProxyFacts): boolean {
  if (asset.type !== "video") return false;
  if ((asset.width ?? 0) * (asset.height ?? 0) > HEAVY_PIXELS) return true;
  return !!asset.sizeBytes && asset.duration > 0 && (asset.sizeBytes * 8) / asset.duration > HEAVY_BITS_PER_SECOND;
}

/** A video whose master needs a proxy and has none: a ProRes master, or a
 * heavy video when the project streams its media (`streamed`, a cloud
 * project). */
export function needsProxy(asset: ProxyFacts, streamed = false): boolean {
  if (asset.type !== "video" || asset.block) return false;
  if (isProres(asset)) return !asset.proxy;
  if (!streamed || !isHeavyVideo(asset)) return false;
  // A heavy video's proxy is the light one; an older full-quality proxy
  // streams no lighter than its master, so it is asked for again.
  return !asset.proxy || !isLightProxyName(asset.proxy.fileName);
}

/** The codec string of the worker's proxy: HEVC Main10. */
const PROXY_DECODE_CODEC = "hvc1.2.4.L123.B0";

/** Whether this browser decodes the proxy a heavy video would get. A heavy
 * master plays here already, only slowly, so where HEVC does not decode it
 * stays on the master, the file that plays. */
async function proxyDecodes(): Promise<boolean> {
  const decoder = (globalThis as { VideoDecoder?: { isConfigSupported?: (c: VideoDecoderConfig) => Promise<{ supported?: boolean }> } }).VideoDecoder;
  if (!decoder?.isConfigSupported) return false;
  try {
    return !!(await decoder.isConfigSupported({ codec: PROXY_DECODE_CODEC, codedWidth: 1920, codedHeight: 1080 })).supported;
  } catch {
    return false;
  }
}

/** What the panel shows about an asset's proxy. */
export type ProxyState =
  | { kind: "making"; progress: number }
  /** No residency could make one; the preview plays the master. */
  | { kind: "none" }
  | ({ kind: "failed"; error: string } & ErrorFields);

// A proxy that failed with nothing more to say.
const proxyFailed = () => new UserError("proxy_failed", "Could not make the preview proxy.");

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

/** The proxy an asset wants in this page: the compat proxy of a stream this
 * browser cannot decode (light for a heavy video the cloud streams), or the
 * preview proxy of a ProRes or heavy master. */
type ProxyAsk = { kind: "compat"; cover: CompatCover; light: boolean } | { kind: "preview" };

async function proxyAsk(asset: MediaAsset, backend: CutBackend): Promise<ProxyAsk | null> {
  const streamed = backend.kind === "cloud";
  const cover = await compatNeedOf(asset);
  if (cover) {
    const light = streamed && isHeavyVideo(asset);
    const held = asset.proxy?.fileName;
    if (held && compatCovers(held, cover) && (!light || isLightProxyName(held))) return null;
    return { kind: "compat", cover, light };
  }
  if (!needsProxy(asset, streamed)) return null;
  if (!isProres(asset) && !(await proxyDecodes())) return null;
  return { kind: "preview" };
}

/**
 * Make sure the asset has the proxy this page needs: build one through the
 * residency that can, and write it onto the asset. Runs once per asset at a
 * time; a second ask while one is on its way does nothing. A failure leaves
 * the asset on the master and says so in the panel.
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
  watchCovers();
  if (asset.upload || asset.block || inFlight.has(asset.id)) return;
  inFlight.add(asset.id);
  try {
    const ask = await proxyAsk(asset, backend);
    if (!ask) return;
    const jobs = useProxyJobs.getState();
    const progress = (p: number) => jobs.set(asset.id, { kind: "making", progress: Math.max(0, Math.min(1, p)) });
    progress(0);
    try {
      const landed =
        ask.kind === "compat"
          ? await buildCompat(projectId, asset, backend, ask, progress)
          : await buildProxy(projectId, asset, backend, progress);
      if (!landed) {
        jobs.set(asset.id, { kind: "none" });
        return;
      }
      const proxyUrl = await storedMediaUrl(projectId, landed.fileName, backend);
      useEditor.getState().setAssetProxy(asset.id, { fileName: landed.fileName, sizeBytes: landed.sizeBytes }, proxyUrl);
      jobs.set(asset.id, null);
      // The strip and the waveform of a stream this page could not read
      // waited for the compat proxy; they read it now.
      const live = useEditor.getState().assets.find((a) => a.id === asset.id);
      if (ask.kind === "compat" && live) void enrichAsset(live);
    } catch (e) {
      jobs.set(asset.id, { kind: "failed", ...errorFields(e, proxyFailed()) });
    }
  } finally {
    inFlight.delete(asset.id);
  }
}

/** Whether the asset waits on a compat proxy for `stream`: this browser
 * cannot decode it, and the asset holds no proxy that covers it yet. */
export async function awaitsCompat(asset: MediaAsset, stream: CompatCover): Promise<boolean> {
  if (frameSinkIsCustom()) return false;
  const need = await compatNeedOf(asset);
  if (!need || (stream === "video" && need !== "video")) return false;
  return !asset.proxy || !compatCovers(asset.proxy.fileName, need);
}

let coverPass = 0;

/** Point this page's readers of each stream it cannot decode at the asset's
 * compat proxy (mediaRead.ts). Every other browser reads the masters, so a
 * proxy another browser built changes nothing here. */
async function syncCovers(assets: MediaAsset[]): Promise<void> {
  const pass = ++coverPass;
  const video = new Map<string, string>();
  const audio = new Map<string, string>();
  for (const a of assets) {
    if (!a.proxy || !a.proxyUrl || !compatCoverOf(a.proxy.fileName)) continue;
    const need = await compatNeedOf(a);
    if (!need || !compatCovers(a.proxy.fileName, need)) continue;
    audio.set(a.url, a.proxyUrl);
    if (need === "video") video.set(a.url, a.proxyUrl);
  }
  if (pass === coverPass) setStreamCovers({ video, audio });
}

let watchingCovers = false;

/** Keep the covers in step with the doc from the first proxy ask on. */
function watchCovers(): void {
  if (watchingCovers) return;
  watchingCovers = true;
  void syncCovers(useEditor.getState().assets);
  useEditor.subscribe((s, prev) => {
    if (s.assets !== prev.assets) void syncCovers(s.assets);
  });
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
  // The master plays from this moment; whether the proxy leaves the doc
  // waits on why it failed.
  s.holdProxyOff(asset.id);
  // A page with no decoder for the proxy's codec cannot play it, however
  // sound the file: the proxy stays on the doc for the viewers who can.
  if (await proxyCodecMissing(live, backend)) return;
  const broken = live.proxy;
  releaseProxyHold(asset.id);
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

/** True when the proxy's file reads but this page has no decoder for its
 * video, e.g. the worker's or the Mac's HEVC in Firefox. A file that does not
 * read at all is broken, and false. */
async function proxyCodecMissing(asset: MediaAsset, backend: CutBackend): Promise<boolean> {
  const projectId = useEditor.getState().projectId;
  if (!projectId || !asset.proxy) {
    return false;
  }
  try {
    const url = await storedMediaUrl(projectId, asset.proxy.fileName, backend);
    return await withMedia(url, async (input) => (await input.canRead()) && (await hasUndecodableVideo(input)));
  } catch {
    return false;
  }
}

/** Every asset in the open project that still needs a proxy here. */
export function ensureProjectProxies(): void {
  const s = useEditor.getState();
  if (!s.projectId || s.readOnly) return;
  for (const asset of s.assets) if (asset.type !== "image") void ensureProxy(s.projectId, asset);
}

/** Ask the project's engine or worker for a proxy. The engine builds it at
 * once; the cloud answers with one already built or a job to poll. */
async function requestProxy(
  projectId: string,
  backend: CutBackend,
  body: Record<string, unknown>,
  onProgress: (p: number) => void
): Promise<Landed> {
  const res = await backend.fetch(`/api/cut/projects/${projectId}/proxy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const started = (await res.json().catch(() => ({}))) as Partial<Landed> & { jobId?: string; error?: string };
  if (!res.ok) throw errorFromBody(started, proxyFailed());
  if (started.fileName && typeof started.sizeBytes === "number") {
    return { fileName: started.fileName, sizeBytes: started.sizeBytes };
  }
  if (backend.kind !== "cloud" || !started.jobId) throw errorFromBody(started, proxyFailed());
  const result = await pollCloudJob<Partial<Landed>>(started.jobId, backend, proxyFailed(), {
    timedOut: new UserError("proxy_too_slow", "The preview proxy took too long."),
    onProgress,
  });
  if (!result.fileName || typeof result.sizeBytes !== "number") throw proxyFailed();
  return { fileName: result.fileName, sizeBytes: result.sizeBytes };
}

/** Build the compat proxy through the residency that can. The Mac's ffmpeg
 * carries no VP9 encoder, so it builds only a sound cover; a picture cover for
 * a browser or Mac project goes to the worker by way of the cloud shelf and is
 * stored back in the project. */
async function buildCompat(
  projectId: string,
  asset: MediaAsset,
  backend: CutBackend,
  ask: Extract<ProxyAsk, { kind: "compat" }>,
  onProgress: (p: number) => void
): Promise<Landed | null> {
  const { proxyMaxHeight, proxyCrf } = CUT_COLOR;
  if (backend.kind === "local" && ask.cover === "audio") {
    if (!(await engineFeatures()).has("media.compat")) return null;
    return requestProxy(projectId, backend, { file: asset.fileName, maxHeight: proxyMaxHeight, crf: proxyCrf, compat: ask.cover }, onProgress);
  }
  if (backend.kind === "cloud") {
    const light = ask.light ? { maxHeight: Math.min(proxyMaxHeight, HEAVY_PROXY_MAX_HEIGHT) } : {};
    return requestProxy(projectId, backend, { file: asset.fileName, compat: ask.cover, ...light }, onProgress);
  }
  const master = async () => resolveRegisteredBlob(asset.url) ?? (await (await fetch(asset.url)).blob());
  const onTheMac = ask.cover === "audio" ? await proxyOnTheMac(master, asset.fileName, proxyMaxHeight, proxyCrf, ask.cover) : null;
  const blob = onTheMac ?? (await compatInTheCloud(new File([await master()], asset.fileName), ask.cover, onProgress));
  const fileName = await uploadProjectMediaTo(backend, projectId, blob, compatProxyNameFor(asset.fileName, ask.cover, false));
  return { fileName, sizeBytes: blob.size };
}

async function buildProxy(
  projectId: string,
  asset: MediaAsset,
  backend: CutBackend,
  onProgress: (p: number) => void
): Promise<Landed | null> {
  const { proxyMaxHeight, proxyCrf } = CUT_COLOR;
  if (backend.kind === "local") {
    if (!(await engineFeatures()).has("media.proxy")) return null;
    return requestProxy(projectId, backend, { file: asset.fileName, maxHeight: proxyMaxHeight, crf: proxyCrf }, onProgress);
  }
  if (backend.kind === "cloud") {
    // A heavy video's proxy is there to stream light; a ProRes master's
    // keeps the account's size.
    const light = isProres(asset) ? {} : { maxHeight: Math.min(proxyMaxHeight, HEAVY_PROXY_MAX_HEIGHT) };
    return requestProxy(projectId, backend, { file: asset.fileName, ...light }, onProgress);
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
