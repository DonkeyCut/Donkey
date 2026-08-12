"use client";

import type React from "react";

interface DragOpts {
  onMove: (dx: number, dy: number, ev: PointerEvent) => void;
  onUp?: (dx: number, dy: number, moved: boolean) => void;
  /** Cursor to hold for the whole gesture, wherever the pointer travels. Read
   * again after every move, so a cursor that turns with what it is dragging
   * keeps up. */
  cursor?: () => string;
}

// Live count of in-flight pointer drags, so layout that depends on clip
// geometry (e.g. the timeline's scrollable width) can hold still until release.
let activeDrags = 0;
const dragListeners = new Set<() => void>();

export function subscribeDragActive(fn: () => void) {
  dragListeners.add(fn);
  return () => {
    dragListeners.delete(fn);
  };
}

export function isDragActive() {
  return activeDrags > 0;
}

/** Pointer-drag helper: tracks deltas from pointerdown until release. */
export function startDrag(e: React.PointerEvent, opts: DragOpts) {
  // Primary button only: a right-click opens the context menu, which swallows
  // the pointerup and would leave the drag armed after the menu closes.
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  // preventDefault also suppresses the browser's default focus move, so end
  // any in-progress text edit here or keyboard shortcuts keep typing into it.
  if (document.activeElement !== e.currentTarget) {
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  const startX = e.clientX;
  const startY = e.clientY;
  let moved = false;
  activeDrags++;
  dragListeners.forEach((fn) => fn());

  // A drag pulls the pointer off the handle within a few pixels, and from there
  // the cursor belongs to whatever it happens to be over. One document-wide
  // rule outranks all of them until the gesture ends.
  const pin = opts.cursor ? document.createElement("style") : null;
  let pinned = "";
  const holdCursor = () => {
    if (!pin || !opts.cursor) return;
    const next = opts.cursor();
    if (next === pinned) return;
    pinned = next;
    pin.textContent = `*, *::before, *::after { cursor: ${next} !important; }`;
  };
  if (pin) {
    holdCursor();
    document.head.append(pin);
  }

  // Pointer events arrive faster than the screen can show the result — a
  // high-rate mouse fires several times between two frames, and a trackpad
  // delivers a burst at once. Handling each one runs the whole response (a
  // seek, a clip move, a re-layout) for a position that is overwritten before
  // anything is painted. Coalescing to one call per frame does the work once,
  // for where the pointer actually ended up.
  let latest: PointerEvent | null = null;
  let frame = 0;
  const flush = () => {
    frame = 0;
    const ev = latest;
    if (!ev) return;
    latest = null;
    opts.onMove(ev.clientX - startX, ev.clientY - startY, ev);
    holdCursor();
  };
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
    latest = ev;
    if (!frame) frame = requestAnimationFrame(flush);
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    // Land the last position before the gesture ends, so a fast release
    // finishes where the pointer was rather than one frame behind it.
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    flush();
    pin?.remove();
    activeDrags--;
    dragListeners.forEach((fn) => fn());
    opts.onUp?.(ev.clientX - startX, ev.clientY - startY, moved);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}
