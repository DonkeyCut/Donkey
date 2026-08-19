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

/** The longest a move rehearsal takes. A move runs the element's whole span,
 * which can be half a minute; anything past this sweeps the same motion
 * through in this long instead, so the shape reads without the wait. */
const MOVE_REHEARSAL_MAX = 2.4;

/**
 * Play `slot` on `o` from its own starting point: In sweeps the head of the
 * element, Out its tail, a loop runs one cycle, and a move runs the element's
 * whole span. The run carries that slot alone, so rehearsing one animation
 * never drags the element's others into the picture. Nothing plays when the
 * slot is empty.
 */
export function playAnimPreview(
  o: { id: string; start: number; end: number; anim?: OverlayAnim },
  slot: "in" | "out" | "loop" | "move"
): void {
  stopAnimPreview();
  // A move is not an anim slot: it is written into the element's own pose
  // track, so its run carries no anim at all and the track alone draws it.
  const anim: OverlayAnim =
    slot === "in"
      ? { in: o.anim?.in }
      : slot === "out"
        ? { out: o.anim?.out }
        : slot === "loop"
          ? { loop: o.anim?.loop }
          : {};
  const dur = Math.max(0.1, o.end - o.start);
  const span =
    slot === "move"
      ? dur
      : slot === "loop"
        ? (loopPeriod(anim) ?? 0)
        : Math.min((slot === "in" ? anim.in?.seconds : anim.out?.seconds) ?? 0, dur);
  if (span <= 0) return;
  // How long the rehearsal takes on the wall clock. Every slot but a move
  // plays at its own speed; a long move is compressed into the cap.
  const window = slot === "move" ? Math.min(span, MOVE_REHEARSAL_MAX) : span;
  // Where the slot lives inside the element: In, a loop and a move start at
  // its head, Out ends at its tail.
  const from = slot === "out" ? dur - span : 0;
  const t0 = performance.now();
  const step = () => {
    const elapsed = (performance.now() - t0) / 1000;
    if (elapsed >= window) {
      stopAnimPreview();
      rested = o.id;
      notify();
      return;
    }
    run = { id: o.id, tLocal: from + (elapsed / window) * span, anim };
    notify();
    frame = requestAnimationFrame(step);
  };
  run = { id: o.id, tLocal: from, anim };
  notify();
  frame = requestAnimationFrame(step);
}
