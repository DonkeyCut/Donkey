"use client";

// A short name for one recording, read off the clip itself.
//
// A phone recording arrives named after the clock it was shot on, so a camera
// roll of them reads as one repeated string. This pulls the opening speech and
// one still out of the media the page is already showing, hands both to the
// hosted titler (server/cloud/clipTitle.ts), and gets back a few words naming
// what the clip is about. The shelf stores the answer, so a clip is read once
// and every device sees the same title afterwards.
//
// The reads go through the media seams — the audio span decoder and the frame
// sink — so this works wherever those do.

import { useEffect, useRef } from "react";
import { encodeWav } from "./cloudTranscribe";
import {
  libraryMediaUrl,
  libraryPosterUrl,
  type LibraryAsset,
  type LibraryData,
} from "./library";
import { decodeAudioSpan, frameAt } from "./mediaRead";
import { createRasterCanvas, decodeRasterImage, rasterCanvasToBlob } from "./raster";
import { backendFor } from "./residency";

/** How much of the opening the titler hears. Long enough for someone to say
 * what they are doing, short enough that reading it is a fraction of the file
 * rather than the whole clip. */
const LISTEN_SECONDS = 30;
/** The wire rate the hosted models read speech at, matching transcription. */
const RATE = 16000;
/** Wider than this teaches the model nothing more about one frame. */
const FRAME_WIDTH = 512;
/** Below this the span is silence and worth no round trip. */
const SILENCE_PEAK = 1e-3;
/** What the titler will look at. A cover comes off the shelf as it was stored;
 * anything else is encoded here. */
const FRAME_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
/** What the titler accepts in one request; anything larger is redrawn small. */
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

/** The clip's opening as 16 kHz mono, the format the hosted models read, or
 * null when the file has no audio or opens on silence. */
async function opening(url: string, duration: number): Promise<Blob | null> {
  const span = Math.min(LISTEN_SECONDS, duration > 0 ? duration : LISTEN_SECONDS);
  const buf = await decodeAudioSpan(url, 0, span).catch(() => null);
  if (!buf || buf.length === 0) return null;
  const ctx = new OfflineAudioContext(
    1,
    Math.max(1, Math.round((buf.length / buf.sampleRate) * RATE)),
    RATE,
  );
  const source = ctx.createBufferSource();
  source.buffer = buf;
  source.connect(ctx.destination);
  source.start();
  const mono = (await ctx.startRendering()).getChannelData(0);
  for (let i = 0; i < mono.length; i++) {
    if (Math.abs(mono[i]) > SILENCE_PEAK) return encodeWav(mono);
  }
  return null;
}

/** One frame to look at: the cover the clip already carries, the picture
 * itself, or a frame read out of the video. */
async function still(a: LibraryAsset): Promise<Blob | null> {
  const url = libraryMediaUrl(a.fileName, a.residency);
  const poster = libraryPosterUrl(a);
  if (poster || a.type === "image") {
    const stored = await fetch(poster ?? url, { mode: "cors" })
      .then((r) => (r.ok ? r.blob() : null))
      .catch(() => null);
    if (stored && stored.size > 0) return sendable(stored);
  }
  if (a.type !== "video") return null;
  const wrapped = await frameAt(url, Math.min(1, (a.duration || 2) / 2), {
    width: FRAME_WIDTH,
  }).catch(() => null);
  return wrapped ? rasterCanvasToBlob(wrapped.canvas, "image/jpeg", 0.7) : null;
}

/** A stored picture as the titler will take it: small enough to ride the
 * request and in a format it reads, redrawn through the raster seam when the
 * bytes on the shelf are neither. */
async function sendable(blob: Blob): Promise<Blob | null> {
  if (blob.size <= MAX_FRAME_BYTES && FRAME_MIMES.has(blob.type)) return blob;
  const image = await decodeRasterImage(blob);
  if (!image?.width || !image.height) return null;
  const w = Math.min(FRAME_WIDTH, image.width);
  const h = Math.max(1, Math.round((image.height / image.width) * w));
  const canvas = createRasterCanvas(w, h);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) return null;
  ctx.drawImage(image.source, 0, 0, w, h);
  return rasterCanvasToBlob(canvas, "image/jpeg", 0.7);
}

/** Read one clip and hand back the title the shelf now holds for it, or null
 * when there was nothing to read it from. Already-titled assets come back with
 * the title they have without a model call. */
export async function titleClip(a: LibraryAsset): Promise<string | null> {
  if (a.title) return a.title;
  const [audio, frame] = await Promise.all([
    opening(libraryMediaUrl(a.fileName, a.residency), a.duration).catch(() => null),
    still(a).catch(() => null),
  ]);
  if (!audio && !frame) return null;
  const form = new FormData();
  form.set("assetId", a.id);
  if (audio) form.set("audio", new File([audio], "opening.wav", { type: "audio/wav" }));
  if (frame) {
    const type = FRAME_MIMES.has(frame.type) ? frame.type : "image/jpeg";
    form.set("frame", new File([frame], "frame", { type }));
  }
  const res = await backendFor(a.residency).fetch("/api/cut/library/title", {
    method: "POST",
    body: form,
  });
  if (!res.ok) return null;
  const { title } = (await res.json()) as { title?: string };
  return title?.trim() || null;
}

/** How many clips are read for a title at once. Each one pulls the opening of
 * its own file across the network, so a shelf that just filled up titles
 * itself a couple at a time rather than all at once. */
const TITLING_AT_ONCE = 2;

/** Give every untitled clip on a surface a name read off itself.
 *
 * The work happens once per clip — the shelf stores the answer, and every
 * surface showing that clip reads it afterwards — and a clip that fails is
 * left alone until the surface is opened again, so nothing loops on a file
 * that cannot be read. Hand it an empty list where the clips are not on
 * screen: a picker nobody has opened has no reason to read files.
 */
export function useClipTitles(
  clips: LibraryAsset[],
  patch: (fn: (d: LibraryData) => LibraryData) => void,
) {
  const shelf = useRef(clips);
  const claimed = useRef(new Set<string>());
  const running = useRef(0);
  // The listing is re-read on a timer, so the array itself is new every render.
  // What says there is work to do is which clips still want a name.
  const untitled = clips
    .filter((c) => !c.title)
    .map((c) => c.id)
    .join(" ");

  useEffect(() => {
    shelf.current = clips;
  });

  useEffect(() => {
    let live = true;
    const pump = () => {
      while (live && running.current < TITLING_AT_ONCE) {
        const next = shelf.current.find((c) => !c.title && !claimed.current.has(c.id));
        if (!next) return;
        claimed.current.add(next.id);
        running.current += 1;
        void titleClip(next)
          .then((title) => {
            // A title that landed is kept even if the surface has since been
            // left: the server already wrote it, and the listing this cache
            // holds should say the same thing.
            if (!title) return;
            patch((d) => ({
              ...d,
              assets: d.assets.map((x) => (x.id === next.id ? { ...x, title } : x)),
            }));
          })
          .catch(() => {})
          .finally(() => {
            running.current -= 1;
            pump();
          });
      }
    };
    pump();
    return () => {
      live = false;
    };
  }, [untitled, patch]);
}
