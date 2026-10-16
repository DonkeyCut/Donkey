"use client";

/**
 * What this browser decodes of the two codecs every converter writes: H.264
 * picture and AAC sound.
 *
 * Nearly every browser decodes both. Firefox on a Linux machine without the
 * system's codecs has no H.264, and some browsers built on Chromium (Opera,
 * Yandex) say they decode AAC and then fail on every packet — so the AAC
 * answer comes from decoding a real tenth of a second of it, and the H.264
 * one from the decoder's own config check. The answer is kept per browser
 * version, so a session in a browser that decodes both pays nothing past its
 * first. A browser missing one gets a compat proxy per clip (mediaProxy.ts).
 */

import { audioChunks, frameSinkIsCustom, withMedia } from "./mediaRead";
import type { CompatCover } from "./proxyNames";
import type { MediaAsset } from "./types";

export interface BrowserCodecs {
  h264: boolean;
  aac: boolean;
}

/** The checks and the place their answer is kept, swapped by the test. */
export interface CodecProbes {
  h264: () => Promise<boolean>;
  aac: () => Promise<boolean>;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  /** Which browser build answered: a new version asks again. */
  agent: string;
}

const STORAGE_KEY = "cut-codecs";

/** The config the H.264 check asks about: High profile at 720p, what phones
 * and the converters write. */
const H264_CONFIG = { codec: "avc1.64001f", codedWidth: 1280, codedHeight: 720 };

/** A tenth of a second of 48 kHz stereo AAC-LC in an MP4. */
const AAC_SAMPLE = "AAAAHGZ0eXBNNEEgAAACAE00QSBpc29taXNvMgAAAxNtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAZAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACPXRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAZAAAAAAAAAAAAAAAAQEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAAGQAAAQAAAEAAAAAAbVtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAALuAAAAWwFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAAFgbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAEkc3RibAAAAGpzdHNkAAAAAAAAAAEAAABabXA0YQAAAAAAAAABAAAAAAAAAAAAAgAQAAAAALuAAAAAAAA2ZXNkcwAAAAADgICAJQABAASAgIAXQBUAAAAAAH75AAB++QWAgIAFEZBW5QAGgICAAQIAAAAgc3R0cwAAAAAAAAACAAAABQAABAAAAAABAAACwAAAABxzdHNjAAAAAAAAAAEAAAABAAAABgAAAAEAAAAsc3RzegAAAAAAAAAAAAAABgAAAFYAAAB8AAAASAAAAEcAAABIAAAARAAAABRzdGNvAAAAAAAAAAEAAAM/AAAAGnNncGQBAAAAcm9sbAAAAAIAAAAB//8AAAAcc2JncAAAAAByb2xsAAAAAQAAAAYAAAABAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2Mi4xMi4xMDEAAAAIZnJlZQAAAfVtZGF03gIATGF2YzYyLjI4LjEwMQBCSqpYMT1q51483epqXIuwEEQUmWqLXyaGCaabLxqqq+U02Xjx48fllmii48ePyy5YouNKNVq51483epqXIuwAAAAAA4AhRWz///zFkpZGWSllI3+vXHj/X9/Or/+P3869v/p+POhtTs265jMGqk6rO5pb0Up0yVlaLDsfy2X/lsEUaAht6ZBIKJ53XWmI5qsRCGJnyiZ8omEqHLCfgPOLOBITMDRo0a3+vXHj/X9/Or/+P3869v/p+POgAAAAAAHAIXWUyVmT+P6fr1xx54nU001egf+G0vufHxmbd9/cH+Pgyff3A+PgD394R8fGYe/vCDzI2ZP4/p+vXHHnidTTTV6AAAAAAAOAIRWUAUxG57/4//i/8v9/94Xql555KEUUS16DGiiiiii7oooiKKJCKon0IqQgqOqAGznv/j/+L/y/3/3heqXnnkoAAAAAABwhFZTyWZe/9f9PNru9S5JcQET4Bw/n6vEI2zA+xg+IjbMD4GD4iMsYHwUT4iOkYHwUWxEc8NmXv/X/Tza7vUuSXEAAAAAAAcAhFZUKWUzc4XLly5JckH8ryrbf1UUFbaaCkpI6NiKmhUJI6NipmhUKjo2KmaFQ0Do2KmzQjZTNzhcuXLklyQAAAAAABw==";

async function h264Decodes(): Promise<boolean> {
  if (typeof VideoDecoder === "undefined") return false;
  try {
    return !!(await VideoDecoder.isConfigSupported(H264_CONFIG)).supported;
  } catch {
    return false;
  }
}

async function aacDecodes(): Promise<boolean> {
  const bytes = Uint8Array.from(atob(AAC_SAMPLE), (c) => c.charCodeAt(0));
  try {
    for await (const chunk of audioChunks(new Blob([bytes], { type: "audio/mp4" }))) {
      void chunk;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Read the stored answer for this browser build, or run the checks once and
 * keep theirs. */
export async function readCodecs(io: CodecProbes): Promise<BrowserCodecs> {
  try {
    const held = JSON.parse(io.storage?.getItem(STORAGE_KEY) ?? "null") as (BrowserCodecs & { agent?: string }) | null;
    if (held?.agent === io.agent) return { h264: !!held.h264, aac: !!held.aac };
  } catch {
    // An unreadable entry is asked again.
  }
  const [h264, aac] = await Promise.all([io.h264(), io.aac()]);
  try {
    io.storage?.setItem(STORAGE_KEY, JSON.stringify({ agent: io.agent, h264, aac }));
  } catch {
    // Storage is a convenience; the answer stands for this session.
  }
  return { h264, aac };
}

const BOTH: BrowserCodecs = { h264: true, aac: true };
let answer: Promise<BrowserCodecs> | null = null;

/** What this browser decodes. A headless runtime reads media through ffmpeg
 * and decodes both. */
export function browserCodecs(): Promise<BrowserCodecs> {
  if (typeof document === "undefined" || frameSinkIsCustom()) return Promise.resolve(BOTH);
  let storage: CodecProbes["storage"] = null;
  try {
    storage = localStorage;
  } catch {
    // A page with storage blocked asks once per session.
  }
  return (answer ??= readCodecs({ h264: h264Decodes, aac: aacDecodes, storage, agent: navigator.userAgent }));
}

/** The codecs of a master's two streams, read off its header once per file,
 * by its address without the query a signed link re-mints. */
const masterCodecs = new Map<string, Promise<{ video: string | null; audio: string | null }>>();

function codecsOf(asset: Pick<MediaAsset, "url">) {
  const key = asset.url.split("?")[0];
  let read = masterCodecs.get(key);
  if (!read) {
    read = withMedia(asset.url, async (input) => {
      const [video, audio] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
      return { video: video?.codec ?? null, audio: audio?.codec ?? null };
    });
    // A failed read is asked again by the next caller.
    read.catch(() => masterCodecs.delete(key));
    masterCodecs.set(key, read);
  }
  return read;
}

/** The stream of the asset's master this browser cannot decode, as the compat
 * cover that carries it (proxyNames.ts): "video" for H.264 picture, which
 * covers the sound too, "audio" for AAC sound. Null when this browser decodes
 * the master — every browser that decodes both codecs answers without reading
 * the file. ProRes has its own proxy and WASM decoder, and takes none. */
export async function compatNeedOf(
  asset: Pick<MediaAsset, "type" | "url" | "block" | "color">
): Promise<CompatCover | null> {
  if ((asset.type !== "video" && asset.type !== "audio") || asset.block) {
    return null;
  }
  if (asset.color?.codec?.startsWith("ap")) {
    return null;
  }
  const codecs = await browserCodecs();
  if (codecs.h264 && codecs.aac) {
    return null;
  }

  const master = await codecsOf(asset).catch(() => null);
  if (!master) {
    return null;
  }
  if (asset.type === "video" && !codecs.h264 && master.video === "avc") {
    return "video";
  }
  return !codecs.aac && master.audio === "aac" ? "audio" : null;
}
