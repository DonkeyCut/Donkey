"use client";

/**
 * Lottie sticker assets: the animation JSON lives in the project's media/
 * folder (origin "sticker"); this module fetches and caches the documents and
 * hands out seekable players. Export paths share one handle per asset (their
 * seeks are sequential); each preview element makes its own, so two copies of
 * a sticker can sit on different frames.
 */

import { createLottieHandle, isLottieData, type LottieHandle } from "@donkeycut/effects-kit";
import type { MediaAsset } from "./types";

const dataCache = new Map<string, Promise<unknown | null>>();
const sharedHandles = new Map<string, Promise<LottieHandle | null>>();

/** Whether an asset holds a Lottie document (sticker imports store them with
 * their .json name). */
export const isLottieAsset = (a: { fileName: string; name?: string }) =>
  /\.json$/i.test(a.fileName) || /\.json$/i.test(a.name ?? "");

function lottieData(asset: MediaAsset): Promise<unknown | null> {
  let hit = dataCache.get(asset.id);
  if (!hit) {
    hit = fetch(asset.url)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => (isLottieData(data) ? data : null))
      .catch(() => {
        dataCache.delete(asset.id);
        return null;
      });
    dataCache.set(asset.id, hit);
  }
  return hit;
}

/** The shared export-side handle for an asset (sequential seeks only). */
export function sharedLottieHandle(
  assetId: string,
  assets: MediaAsset[]
): Promise<LottieHandle | null> {
  let hit = sharedHandles.get(assetId);
  if (!hit) {
    const asset = assets.find((a) => a.id === assetId);
    hit = asset
      ? lottieData(asset).then((data) => (data ? createLottieHandle(data) : null))
      : Promise.resolve(null);
    sharedHandles.set(assetId, hit);
    void hit.then((h) => {
      if (!h) sharedHandles.delete(assetId);
    });
  }
  return hit;
}

/** A private handle for one preview element; destroy it on unmount. */
export async function newLottieInstance(asset: MediaAsset): Promise<LottieHandle | null> {
  const data = await lottieData(asset);
  return data ? createLottieHandle(data) : null;
}
