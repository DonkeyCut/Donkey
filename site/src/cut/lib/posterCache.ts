"use client";

/**
 * A project's opening picture, kept on this machine.
 *
 * A local project's media is a file on this Mac, so a card tile and a freshly
 * opened editor draw their first frame in the same breath as the layout. A
 * cloud project's media is a network away: the card holds a grey rectangle and
 * the preview holds black for about a second while a decoder fetches metadata,
 * seeks and decodes — every single time, on a project you have opened a dozen
 * times already. The frame is small, it is the one thing you look at first, and
 * it barely changes. So the surfaces that show it keep the last one they drew
 * and paint that immediately; the real decoder replaces it when it arrives.
 *
 * Two pictures, because the two surfaces frame differently. A card crops a
 * source frame to its tile, while the preview shows the composited frame with
 * the project's letterboxing, so a card poster stretched across the preview
 * would be the wrong picture. Each surface caches what it actually draws.
 *
 * Never a source of truth: a miss, a tainted canvas or a browser with no
 * storage costs the wait it used to cost every time.
 */

import { getBackend, type CutMode } from "./backend";
import { readSnapshot, snapshotKey, writeSnapshot } from "./cache";

/** `card` is the tile's cropped source frame; `frame` is the preview canvas's
 * composited picture. */
type PosterKind = "card" | "frame";

// Wide enough that neither surface shows the upscale in the moment before the
// decoder takes over, small enough that a few hundred projects stay cheap.
const WIDTH: Record<PosterKind, number> = { card: 480, frame: 640 };
const QUALITY = 0.72;

// How long to keep asking a surface for its picture, and how often. A card
// element renders its poster frame without ever firing a reliable event — a
// preload="metadata" video may never reach `loadeddata` — so the picture is
// taken by asking rather than by listening.
const POLL_MS = 400;
const POLL_LIMIT_MS = 20_000;

/** Where the project lives. The projects home lists both shelves at once while
 * the ambient backend is whichever the app is running against, so a caller that
 * knows a project's residency says so; anything editing an open project is
 * already pinned to it and can let this default. */
const keyFor = (kind: PosterKind, projectId: string, scope: CutMode = getBackend().kind) =>
  snapshotKey(scope, `poster-${kind}`, projectId);

export async function readPoster(
  kind: PosterKind,
  projectId: string,
  scope?: CutMode
): Promise<string | null> {
  const hit = await readSnapshot<string>(keyFor(kind, projectId, scope));
  return typeof hit?.value === "string" ? hit.value : null;
}

/** Whether `data` holds anything worth keeping. A decoder that is not ready
 * yet leaves the surface black, and caching that would make the next visit
 * paint a black rectangle with confidence — worse than the wait it saves. */
function hasPicture(data: Uint8ClampedArray): boolean {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 12 || data[i + 1] > 12 || data[i + 2] > 12) return true;
  }
  return false;
}

/** Keep `source`'s current picture as this project's opening frame, reporting
 * whether one was there to keep. Safe to call on any frame: a source with no
 * pixels yet, or one still showing black, is skipped, so the stored poster
 * stays the last good one and a caller can keep asking until it lands. */
export function capturePoster(
  kind: PosterKind,
  projectId: string,
  source: HTMLCanvasElement | HTMLVideoElement,
  scope?: CutMode
): boolean {
  const sw = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
  const sh = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
  if (!sw || !sh) return false;
  try {
    const scale = Math.min(1, WIDTH[kind] / sw);
    const scratch = document.createElement("canvas");
    scratch.width = Math.max(1, Math.round(sw * scale));
    scratch.height = Math.max(1, Math.round(sh * scale));
    const ctx = scratch.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(source, 0, 0, scratch.width, scratch.height);
    if (!hasPicture(ctx.getImageData(0, 0, scratch.width, scratch.height).data)) return false;
    writeSnapshot(keyFor(kind, projectId, scope), scratch.toDataURL("image/jpeg", QUALITY));
    return true;
  } catch {
    // A tainted source cannot be read back; the surface keeps waiting on the
    // network the way it always did.
    return false;
  }
}

/** Keep asking `source` for its picture until one is there to keep, then stop.
 * Returns a canceller for the caller's cleanup. */
export function capturePosterWhenReady(
  kind: PosterKind,
  projectId: string,
  source: () => HTMLCanvasElement | HTMLVideoElement | null,
  scope?: CutMode
): () => void {
  const started = performance.now();
  const timer = setInterval(() => {
    const el = source();
    const done = !el || capturePoster(kind, projectId, el, scope);
    if (done || performance.now() - started > POLL_LIMIT_MS) clearInterval(timer);
  }, POLL_MS);
  return () => clearInterval(timer);
}

/** Draw a stored poster over a canvas, contained and centred so a project whose
 * aspect has changed since is letterboxed rather than stretched. */
export function paintPoster(canvas: HTMLCanvasElement, data: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const scale = Math.min(canvas.width / img.width, canvas.height / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      }
      resolve();
    };
    img.onerror = () => resolve();
    img.src = data;
  });
}
