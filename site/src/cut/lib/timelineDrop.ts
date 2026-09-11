"use client";

import type { VideoTrackPlacement } from "./store";
import type { TransitionStyle } from "./types";

/** Where an OS file released over the timeline lands: the time under the
 * pointer, the video row it resolved to and the audio row, a new track or
 * lane included. The timeline owns that resolution — the same one every
 * media drag uses — and publishes it here for the window-level file drop in
 * the editor, which owns the import. */
export interface FileLanding {
  at: number;
  place: VideoTrackPlacement;
  /** The audio display row, one past either edge for a new lane. */
  audioRow: number;
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

let transitionLanding: ((t: number, style: TransitionStyle) => void) | null = null;

/** The mounted timeline registers how a transition lands at a time — the
 * nearest cut or clip edge within reach, else parked there — so a paste lands
 * a bar exactly as a drop does; returns the unregister. */
export function registerTransitionLanding(
  land: (t: number, style: TransitionStyle) => void
): () => void {
  transitionLanding = land;
  return () => {
    if (transitionLanding === land) transitionLanding = null;
  };
}

/** Land a transition bar at `t` the way the timeline lands a dropped one.
 * False when no timeline is mounted. */
export function landTransitionAt(t: number, style: TransitionStyle): boolean {
  if (!transitionLanding) return false;
  transitionLanding(t, style);
  return true;
}
