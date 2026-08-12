"use client";

/**
 * Where the preview is, and where the mouse is hovering over the timeline.
 *
 * These two numbers change more often than anything else in Cut — sixty times a
 * second while playing, and once per pointer event while dragging. They used to
 * live in the editor store beside the clips, which meant every one of those
 * changes ran the document's write normalizer and woke every mounted selector
 * in the editor, a few hundred of them, to ask whether a title bar had moved.
 *
 * So they live here instead, in the smallest store that can hold them: a
 * number, a set of listeners, and nothing else. Surfaces that draw the playhead
 * subscribe; surfaces that only need to know where it is when the user does
 * something read it directly. The document store is left to describe the
 * document.
 *
 * The clamp to the project's length lives with the callers that know the
 * length. This module holds a time and tells people it changed.
 */

import { useSyncExternalStore } from "react";
import { markSeek } from "./perfTrace";

let at = 0;
let skim: number | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Run `fn` on every move, outside React.
 *
 * For surfaces whose whole response to the clock is one DOM write — the
 * playhead's transform, the grade on the picture. Re-rendering a component to
 * set one style property costs a reconcile per frame and buys nothing.
 */
export const subscribePlayhead = subscribe;

/** The playhead, in timeline seconds. */
export const playheadAt = () => at;

/** The skimmer, or null when the pointer is off the timeline. */
export const skimAt = () => skim;

/**
 * The time the picture should show: the skimmer while one is live, the playhead
 * otherwise. One place decides this, so the preview and everything drawing
 * against the preview agree on which moment is on screen.
 */
export const previewAt = () => skim ?? at;

/** Move the playhead. Callers clamp to the project length first. */
export function setPlayhead(t: number): void {
  if (t === at) return;
  at = t;
  markSeek(t);
  notify();
}

export function setSkim(t: number | null): void {
  if (t === skim) return;
  skim = t;
  if (t !== null) markSeek(t);
  notify();
}

/**
 * Hold the playhead inside a timeline that just got shorter. Deleting the last
 * of a long row leaves the playhead standing past the new end, which puts the
 * readout ahead of the total and — since the playhead is placed with a
 * transform, and transforms count toward scrollable overflow — stretches the
 * scroll area into empty space.
 */
export function clampPlayhead(total: number): void {
  if (at > total) setPlayhead(total);
}

/** The playhead, as a subscription. Re-renders the caller on every change. */
export function usePlayhead(): number {
  return useSyncExternalStore(subscribe, playheadAt, () => 0);
}

export function useSkim(): number | null {
  return useSyncExternalStore(subscribe, skimAt, () => null);
}

export function usePreviewTime(): number {
  return useSyncExternalStore(subscribe, previewAt, () => 0);
}

/**
 * Something the preview time decides, without re-rendering when only the time
 * moved — whether a cue is the one being spoken, whether a clip is on screen.
 * `select` must return a primitive: React compares snapshots by identity, and a
 * fresh object every read would loop.
 */
export function usePreviewSelector<T extends string | number | boolean | null>(
  select: (t: number) => T
): T {
  return useSyncExternalStore(
    subscribe,
    () => select(previewAt()),
    () => select(0)
  );
}

/**
 * The preview time rounded to `steps` per second, for surfaces that want the
 * clock without wanting every frame of it — a picker's swatches, a panel's
 * live thumbnail. Rounding inside the snapshot means React compares the coarse
 * value and skips the render, so a 2 Hz caller re-renders twice a second while
 * the preview runs at sixty.
 */
export function usePreviewTimeEvery(steps: number): number {
  return useSyncExternalStore(
    subscribe,
    () => Math.round(previewAt() * steps),
    () => 0
  );
}
