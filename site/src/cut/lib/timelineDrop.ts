"use client";

import type { VideoTrackPlacement } from "./store";

/** Where an OS file released over the timeline lands: the time under the
 * pointer and the video row it resolved to, a new track included. The
 * timeline owns that resolution — the same one every media drag uses — and
 * publishes it here for the window-level file drop in the editor, which
 * owns the import. */
export interface FileLanding {
  at: number;
  place: VideoTrackPlacement;
}

let resolver: ((clientX: number, clientY: number) => FileLanding | null) | null = null;

/** The mounted timeline registers how a point over it lands; returns the
 * unregister. */
export function registerFileLanding(
  resolve: (clientX: number, clientY: number) => FileLanding | null
): () => void {
  resolver = resolve;
  return () => {
    if (resolver === resolve) resolver = null;
  };
}

/** The landing for a release at a point, or null when no timeline is mounted
 * or the point is off its rows. */
export function fileLandingAt(clientX: number, clientY: number): FileLanding | null {
  return resolver?.(clientX, clientY) ?? null;
}
