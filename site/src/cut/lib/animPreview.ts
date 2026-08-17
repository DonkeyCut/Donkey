"use client";

/**
 * A rehearsal clock for one element.
 *
 * Picking an animation in the inspector plays it on the stage right there: the
 * playhead stays where it is, and this store holds which element is rehearsing
 * plus the local time to draw it at. While a run is live the overlay takes
 * that element's time from here, so the run costs one element's re-render per
 * frame and nothing else on the page moves.
 *
 * A run lasts exactly as long as the animation it shows — the In/Out length,
 * or one cycle of a loop. When it ends the element holds its resting pose:
 * the paused playhead may sit mid-fade or mid-spin, and snapping there would
 * leave the element hidden or upside-down right after the pick. The hold
 * lifts the moment the preview clock moves.
 */

import { loopPeriod, type OverlayAnim } from "@donkeycut/effects-kit";
import { useSyncExternalStore } from "react";

/** A live rehearsal: which element, where in the slot's own window, and the
 * slot on its own — the element's other slots are left out of the run so a
 * loop rehearsal is a loop and nothing else. */
export type AnimRun = { id: string; tLocal: number; anim: OverlayAnim };

let run: AnimRun | null = null;
/** The element holding its resting pose after a finished run. */
let rested: string | null = null;
let frame = 0;
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

const at = (id: string): AnimRun | "rest" | null =>
  run?.id === id ? run : rested === id ? "rest" : null;

/** The rehearsal running on this element, `"rest"` while it holds its resting
 * pose after a run, or null when the clock owns it. */
export function useAnimPreview(id: string): AnimRun | "rest" | null {
  return useSyncExternalStore(
    subscribe,
    () => at(id),
    () => null
  );
}

/** End any run in progress and hand the element back to the clock. */
export function stopAnimPreview(): void {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  if (!run && !rested) return;
  run = null;
  rested = null;
  notify();
}

/** Lift the post-run resting hold — the preview clock moved, so the element
 * follows it again. */
export function releaseAnimRest(id: string): void {
  if (rested !== id) return;
  rested = null;
  notify();
}

/**
 * Play `slot` on `o` from its own starting point: In sweeps the head of the
 * element, Out its tail, and a loop runs one cycle. The run carries that slot
 * alone, so rehearsing one animation never drags the element's other two into
 * the picture. Nothing plays when the slot is empty.
 */
export function playAnimPreview(
  o: { id: string; start: number; end: number; anim?: OverlayAnim },
  slot: "in" | "out" | "loop"
): void {
  stopAnimPreview();
  const anim: OverlayAnim =
    slot === "in"
      ? { in: o.anim?.in }
      : slot === "out"
        ? { out: o.anim?.out }
        : { loop: o.anim?.loop };
  const dur = Math.max(0.1, o.end - o.start);
  const window =
    slot === "loop"
      ? (loopPeriod(anim) ?? 0)
      : Math.min((slot === "in" ? anim.in?.seconds : anim.out?.seconds) ?? 0, dur);
  if (window <= 0) return;
  // Where the slot lives inside the element: In and a loop start at its head,
  // Out ends at its tail.
  const from = slot === "out" ? dur - window : 0;
  const t0 = performance.now();
  const step = () => {
    const elapsed = (performance.now() - t0) / 1000;
    if (elapsed >= window) {
      stopAnimPreview();
      rested = o.id;
      notify();
      return;
    }
    run = { id: o.id, tLocal: from + elapsed, anim };
    notify();
    frame = requestAnimationFrame(step);
  };
  run = { id: o.id, tLocal: from, anim };
  notify();
  frame = requestAnimationFrame(step);
}
