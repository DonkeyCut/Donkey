"use client";

import type React from "react";

interface DragOpts {
  onMove: (dx: number, dy: number, ev: PointerEvent) => void;
  onUp?: (dx: number, dy: number, moved: boolean) => void;
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

  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
    opts.onMove(dx, dy, ev);
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    activeDrags--;
    dragListeners.forEach((fn) => fn());
    opts.onUp?.(ev.clientX - startX, ev.clientY - startY, moved);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}
