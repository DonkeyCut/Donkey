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

import {
  AudioSampleSink,
  AudioSampleSource,
  canEncodeAudio,
  canEncodeVideo,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  StreamTarget,
  VideoSample,
  VideoSampleSink,
  VideoSampleSource,
  type VideoCodec,
} from "mediabunny";
import { create } from "zustand";
import { apiFetch as engineFetch, engineFeatures } from "./api";
import { getBackend, hasLocalCompute, type CutBackend } from "./backend";
import { freeName, mediaDir } from "./backend/browser/opfs";
import { resolveRegisteredBlob } from "./backend/browser/registry";
import { pollCloudJob } from "./cloudJob";
import { cutColor } from "./colorSettings";
import { uploadProjectMediaTo } from "./media";
import { audioTrackOf, frameSinkIsCustom, openMedia, probeMediaFile, videoTrackOf } from "./mediaRead";
import { encoderLead } from "./encoderLead";
import { forgetLocalMediaUrl, storedMediaUrl } from "./mediaSync";
import { ensureProresDecoder } from "./proresDecoder";
import { convertPlanes, isPlanarFormat, planesPassThrough, proxySize } from "./proxyPlanes";
import { useEditor } from "./store";
import type { MediaAsset, StoredAsset } from "./types";

/** The proxy's file name beside its master (server/proxy.ts `proxyNameFor`). */
export const proxyNameFor = (fileName: string) =>
  `${fileName.replace(/\.[^./\\]+$/, "") || "media"}.proxy.mp4`;

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

/** The 10-bit codecs the page may encode a proxy with, best first. Chrome
 * encodes 10-bit only as VP9 profile 2. WebKit answers yes to all three and
 * then has no 10-bit `VideoFrame` to feed them — the WASM decoder falls
 * back to 8-bit frames there — so a WebKit page makes no proxy and the Mac
 * beside it does. */
export const PROXY_CODECS: { codec: VideoCodec; fullCodecString: string }[] = [
  { codec: "hevc", fullCodecString: "hev1.2.4.L153.B0" },
  { codec: "av1", fullCodecString: "av01.0.13M.10" },
  { codec: "vp9", fullCodecString: "vp09.02.51.10" },
];

/** A result from any residency: the file the project now holds. */
interface Landed {
  fileName: string;
  sizeBytes: number;
}

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
  const blob = await proxyOnTheMac(asset, proxyMaxHeight, proxyCrf);
  if (!blob) return null;
  const fileName = await uploadProjectMediaTo(backend, projectId, blob, proxyNameFor(asset.fileName));
  return { fileName, sizeBytes: blob.size };
}

/** The first 10-bit codec this browser encodes at the master's size. */
async function encodableProxyCodec(width: number, height: number) {
  for (const c of PROXY_CODECS) {
    if (await canEncodeVideo(c.codec, { width, height, fullCodecString: c.fullCodecString })) return c;
  }
  return null;
}

/** How much encoded output the page holds before it writes to disk. */
export const PROXY_WRITE_CHUNK = 4 * 1024 * 1024;

/** The packet ceilings the reserved header is sized for: the master's own
 * frame count and the AAC frames its duration makes, each with the headroom
 * the muxer asks for. */
export function proxyPacketBudget(videoPackets: number, duration: number, sampleRate: number) {
  return {
    video: Math.ceil(videoPackets * 1.33) + 16,
    audio: Math.ceil(((duration * sampleRate) / 1024) * 1.33) + 16,
  };
}

/** The proxy's muxer: MP4 with its header in space reserved up front, written
 * through `writable` a bounded chunk at a time, so what the page holds does not
 * grow with the master's length. */
export function proxyOutput(writable: WritableStream) {
  return new Output({
    format: new Mp4OutputFormat({ fastStart: "reserve" }),
    target: new StreamTarget(writable, { chunked: true, chunkSize: PROXY_WRITE_CHUNK }),
  });
}

/**
 * Build the proxy in this page and write it into the project's own storage:
 * decode the master through the WASM decoder, carry every frame's planes into
 * Rec.709 limited 4:2:0 at 10 bits, and encode with the browser's first
 * 10-bit codec, streaming the file to disk as it goes; a master taller than
 * the proxy may be is brought down in the same pass. Null when the page
 * cannot: no 10-bit encoder, no AAC encoder for the sound, or a decoder
 * handing out 8-bit frames (WebKit, whose `VideoFrame` takes no 10-bit
 * format).
 */
export async function proxyInPage(
  projectId: string,
  asset: MediaAsset,
  maxHeight: number,
  onProgress: (p: number) => void
): Promise<Landed | null> {
  if (typeof VideoFrame === "undefined") return null;
  await ensureProresDecoder();
  const input = openMedia(asset.url);
  try {
    const video = await videoTrackOf(input);
    if (!video) return null;
    const [coded, duration, rotated] = await Promise.all([
      Promise.all([video.getCodedWidth(), video.getCodedHeight()]),
      input.computeDuration(),
      video.getRotation(),
    ]);
    // The planes are converted at the coded size; the display size is the
    // coded one turned by the container's rotation, which the proxy keeps —
    // so a sideways master's cap applies to its coded width.
    const cap = rotated % 180 === 0 ? maxHeight : Math.round((maxHeight * coded[1]) / Math.max(1, coded[0]));
    const target = proxySize(coded[0], coded[1], cap);
    const codec = await encodableProxyCodec(target.width, target.height);
    if (!codec) return null;
    const audio = await audioTrackOf(input);
    if (audio && !(await canEncodeAudio("aac"))) return null;
    const from = { matrix: asset.color?.matrix ?? "bt709", fullRange: asset.color?.fullRange ?? false } as const;
    const budget = proxyPacketBudget(
      (await video.computePacketStats()).packetCount,
      duration,
      audio ? await audio.getSampleRate() : 0
    );

    const dir = await mediaDir(projectId, true);
    if (!dir) return null;
    const fileName = await freeName(dir, proxyNameFor(asset.fileName));
    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    const output = proxyOutput(writable);
    let landed = false;
    try {
      const videoSource = new VideoSampleSource({
        codec: codec.codec,
        fullCodecString: codec.fullCodecString,
        quality: QUALITY_HIGH,
      });
      output.addVideoTrack(videoSource, { rotation: rotated, maximumPacketCount: budget.video });
      const audioSource = audio ? new AudioSampleSource({ codec: "aac", quality: QUALITY_HIGH }) : null;
      if (audioSource) output.addAudioTrack(audioSource, { maximumPacketCount: budget.audio });
      await output.start();

      const frames = new VideoSampleSink(video);
      for await (const sample of frames.samples()) {
        try {
          const converted = await convertSample(sample, from, target);
          if (!converted) return null;
          try {
            await videoSource.add(converted);
          } finally {
            if (converted !== sample) converted.close();
          }
          if (duration > 0) onProgress(Math.min(0.95, sample.timestamp / duration));
        } finally {
          sample.close();
        }
      }
      if (audio && audioSource) {
        // Each sample goes in early by the encoder's priming, so the edit list
        // trims it and the proxy's sound stays on its picture.
        const lead = await encoderLead("aac", await audio.getSampleRate(), await audio.getNumberOfChannels());
        const sounds = new AudioSampleSink(audio);
        for await (const sample of sounds.samples()) {
          try {
            sample.setTimestamp(sample.timestamp - lead);
            await audioSource.add(sample);
          } finally {
            sample.close();
          }
        }
      }
      await output.finalize();
      // The file the project keeps has to read back as what was asked for.
      const file = await handle.getFile();
      const probe = await probeMediaFile(file);
      const want = rotated % 180 === 0 ? target.width : target.height;
      if (!probe.hasVideo || probe.width !== want) throw new Error("The preview proxy did not read back.");
      landed = true;
      onProgress(1);
      return { fileName, sizeBytes: file.size };
    } finally {
      if (!landed) {
        if (output.state !== "finalized" && output.state !== "canceled") await output.cancel().catch(() => {});
        // A muxer that never started never took the stream.
        if (!writable.locked) await writable.abort().catch(() => {});
        await dir.removeEntry(fileName).catch(() => {});
      }
    }
  } finally {
    input.dispose();
  }
}

/** The sample as Rec.709 limited 4:2:0 10-bit planes, tagged so; the sample
 * itself when it already is that. Null for a frame the page cannot carry at
 * 10 bits. */
async function convertSample(
  sample: VideoSample,
  from: { matrix: "bt709" | "bt601" | "bt2020nc"; fullRange: boolean },
  target: { width: number; height: number }
): Promise<VideoSample | null> {
  const format = sample.format;
  if (!isPlanarFormat(format)) return null;
  const colorSpace = { primaries: "bt709", transfer: "iec61966-2-1", matrix: "bt709", fullRange: false } as const;
  const init = { timestamp: sample.timestamp, duration: sample.duration, colorSpace };
  const data = new ArrayBuffer(sample.allocationSize());
  const layout = await sample.copyTo(data);
  const size = { width: sample.codedWidth, height: sample.codedHeight, maxHeight: target.height };
  if (planesPassThrough(format, from, size) && sample.codedWidth === target.width) {
    return new VideoSample(data, { ...init, format: "I420P10", codedWidth: sample.codedWidth, codedHeight: sample.codedHeight, layout });
  }
  const converted = convertPlanes(
    { format, width: sample.codedWidth, height: sample.codedHeight, data, layout },
    from,
    { maxHeight: target.height }
  );
  return new VideoSample(converted.data, {
    ...init,
    format: converted.format,
    codedWidth: converted.width,
    codedHeight: converted.height,
    layout: converted.layout,
  });
}

/** Hand the master's bytes to the Mac and take the proxy back; the engine
 * keeps nothing. Null when the app is not there or is older than the route. */
async function proxyOnTheMac(asset: MediaAsset, maxHeight: number, crf: number): Promise<Blob | null> {
  if (!hasLocalCompute() || !(await engineFeatures()).has("media.proxy")) return null;
  const bytes = resolveRegisteredBlob(asset.url) ?? (await (await fetch(asset.url)).blob());
  const form = new FormData();
  form.append("file", bytes, asset.fileName);
  form.append("maxHeight", String(maxHeight));
  form.append("crf", String(crf));
  const res = await engineFetch("/api/cut/proxy", { method: "POST", body: form });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not make the preview proxy.");
  }
  return res.blob();
}
