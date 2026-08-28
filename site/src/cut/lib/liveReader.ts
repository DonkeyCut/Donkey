"use client";

/**
 * The one way to open a reader on a project asset. The URL resolves against
 * the open doc on every open — and again on a re-open — so a link re-minted
 * while a long job runs (an import landing in project storage, a signed link
 * refreshed ahead of expiry) is picked up rather than the job dying on the
 * snapshot's expired one.
 */

import { ClipReader } from "./exportRender";
import { useEditor } from "./store";
import type { MediaAsset } from "./types";

export function liveReader(asset: MediaAsset): ClipReader {
  return new ClipReader(
    asset,
    () => useEditor.getState().assets.find((a) => a.id === asset.id)?.url ?? asset.url
  );
}
