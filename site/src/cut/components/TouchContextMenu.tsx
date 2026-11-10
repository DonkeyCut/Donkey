"use client";

import { useEffect } from "react";

/** How long a finger rests before the press opens the context menu. */
const LONG_PRESS_MS = 500;

/** How far the finger may wander and still count as resting, in px. */
const LONG_PRESS_SLOP = 10;

/** Where text editing keeps the system's own long-press. */
const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

/**
 * Long-press opens the context menu on a touch screen. Safari on iPad never
 * fires `contextmenu` for a finger, so a press that rests in place sends one
 * at its point, and every right-click menu in the app answers it. A press that
 * moves, lifts early, or becomes a pinch or a native drag sends nothing. When a
 * menu opens, the click the release would synthesize is swallowed so it does
 * not land on the menu's target.
 */
export function TouchContextMenu() {
  useEffect(() => {
    let timer = 0;
    let pointerId = -1;
    let startX = 0;
    let startY = 0;

    // Stop waiting: the press moved, ended, or turned into another gesture.
    const cancel = () => {
      window.clearTimeout(timer);
      timer = 0;
      pointerId = -1;
    };

    // The release after an opened menu synthesizes a click; eat it, and stand
    // down at the next press if it never comes.
    const swallow = (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      disarm();
    };
    const disarm = () => {
      window.removeEventListener("click", swallow, true);
      window.removeEventListener("pointerdown", disarm, true);
    };

    // The press rested long enough: send the menu event where it rests.
    const fire = () => {
      timer = 0;
      pointerId = -1;
      const target = document.elementFromPoint(startX, startY);
      if (!target) {
        return;
      }
      const menu = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 2,
        clientX: startX,
        clientY: startY,
      });
      const handled = !target.dispatchEvent(menu);
      if (!handled) {
        return;
      }
      window.addEventListener("click", swallow, true);
      window.addEventListener("pointerdown", disarm, true);
    };

    // Capture phase: drags stop their press from bubbling, and a long press
    // on a clip still has to reach here.
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch") {
        return;
      }
      if (!e.isPrimary || timer) {
        cancel();
        return;
      }
      if ((e.target as Element | null)?.closest?.(EDITABLE)) {
        return;
      }
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      timer = window.setTimeout(fire, LONG_PRESS_MS);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) {
        return;
      }
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > LONG_PRESS_SLOP) {
        cancel();
      }
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId === pointerId) {
        cancel();
      }
    };

    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", end, true);
    document.addEventListener("pointercancel", end, true);
    document.addEventListener("dragstart", cancel, true);
    return () => {
      cancel();
      disarm();
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", end, true);
      document.removeEventListener("pointercancel", end, true);
      document.removeEventListener("dragstart", cancel, true);
    };
  }, []);

  return null;
}
