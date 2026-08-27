"use client";

/**
 * Decoded stills for removal backdrops. A backdrop fill names an image asset;
 * the compositor asks for its pixels synchronously, mid-frame, so the decode
 * happens once out of band and the answer is a cache read. Both hosts share
 * it: the preview asks and repaints when the decode lands, the export awaits
 * the load up front and then reads the same cache.
 */

import { decodeRasterImageUrl, type RasterImage } from "./raster";
import type { MediaAsset } from "./types";

/** Decoded backdrops kept at once; a stale one re-decodes on demand. */
const CACHE_MAX = 12;

/** How long a failed decode rests before the next attempt. A failure is
 * usually transient — an expired signed URL, an asset mid-upload — so it
 * never caches: it just holds off long enough to keep a repainting preview
 * from hammering the fetch. */
const RETRY_MS = 5_000;

const cache = new Map<string, RasterImage>();
const failedAt = new Map<string, number>();
const loading = new Map<string, Promise<RasterImage | null>>();

function remember(assetId: string, img: RasterImage) {
  cache.delete(assetId);
  cache.set(assetId, img);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Start (or join) the decode of one backdrop asset. */
export function loadBackdropStill(asset: MediaAsset): Promise<RasterImage | null> {
  const hit = cache.get(asset.id);
  if (hit) return Promise.resolve(hit);
  const running = loading.get(asset.id);
  if (running) return running;
  const job = decodeRasterImageUrl(asset.url)
    .then((img) => {
      if (img) {
        remember(asset.id, img);
        failedAt.delete(asset.id);
      } else {
        failedAt.set(asset.id, Date.now());
      }
      return img;
    })
    .finally(() => loading.delete(asset.id));
  loading.set(asset.id, job);
  return job;
}

/**
 * The decoded backdrop, or null while it is still decoding (the decode is
 * kicked off and `onLand` fires when it arrives, so the caller can repaint).
 * A failed decode rests briefly and then tries again on the next ask.
 */
export function backdropStill(
  assets: MediaAsset[],
  assetId: string,
  onLand?: () => void
): CanvasImageSource | null {
  const hit = cache.get(assetId);
  if (hit) return hit.source;
  const failed = failedAt.get(assetId);
  if (failed !== undefined && Date.now() - failed < RETRY_MS) return null;
  const asset = assets.find((a) => a.id === assetId);
  if (!asset) return null;
  void loadBackdropStill(asset).then((img) => {
    if (img) onLand?.();
  });
  return null;
}
