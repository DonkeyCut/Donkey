"use client";

/**
 * The page's half of making a preview proxy: encode one in this tab from a
 * master the WASM decoder reads, or hand the master to the Mac's engine and
 * take the proxy back. A project's proxy (mediaProxy.ts) and a library
 * video's playable copy (the browser shelf's library route) both build here;
 * each caller says where the file lands.
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
import { apiFetch as engineFetch, engineFeatures } from "./api";
import { hasLocalCompute } from "./backend";
import { freeName } from "./backend/browser/opfs";
import { audioTrackOf, openMedia, probeMediaFile, videoTrackOf } from "./mediaRead";
import { encoderLead } from "./encoderLead";
import { ensureProresDecoder } from "./proresDecoder";
import { convertPlanes, isPlanarFormat, planesPassThrough, proxySize } from "./proxyPlanes";

/** The proxy's file name beside its master (server/proxy.ts `proxyNameFor`). */
export const proxyNameFor = (fileName: string) =>
  `${fileName.replace(/\.[^./\\]+$/, "") || "media"}.proxy.mp4`;

/** What the master's code values mean: the matrix and range the proxy is
 * carried out of. */
export type ProxyColor = { matrix: "bt709" | "bt601" | "bt2020nc"; fullRange: boolean };

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


/** A result from any residency: the file the shelf or project now holds. */
export interface Landed {
  fileName: string;
  sizeBytes: number;
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
export async function encodeProxyInPage(
  src: string | Blob,
  from: ProxyColor,
  dir: FileSystemDirectoryHandle,
  masterName: string,
  maxHeight: number,
  onProgress: (p: number) => void
): Promise<Landed | null> {
  if (typeof VideoFrame === "undefined") return null;
  await ensureProresDecoder();
  const input = openMedia(src);
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
    const budget = proxyPacketBudget(
      (await video.computePacketStats()).packetCount,
      duration,
      audio ? await audio.getSampleRate() : 0
    );

    const fileName = await freeName(dir, proxyNameFor(masterName));
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
  from: ProxyColor,
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
export async function proxyOnTheMac(
  master: () => Promise<Blob>,
  masterName: string,
  maxHeight: number,
  crf: number
): Promise<Blob | null> {
  if (!hasLocalCompute() || !(await engineFeatures()).has("media.proxy")) return null;
  const bytes = await master();
  const form = new FormData();
  form.append("file", bytes, masterName);
  form.append("maxHeight", String(maxHeight));
  form.append("crf", String(crf));
  const res = await engineFetch("/api/cut/proxy", { method: "POST", body: form });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not make the preview proxy.");
  }
  return res.blob();
}
