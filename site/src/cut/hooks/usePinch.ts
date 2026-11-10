"use client";

import { useEffect, useRef, type RefObject } from "react";

/** WebKit's pinch event: `scale` runs from 1 at the start of the gesture, and
 * the client point is the center between the fingers. */
type GestureEvent = UIEvent & { scale: number; clientX: number; clientY: number };

/** A pinch step: the zoom factor since the last step about the fingers'
 * center, and how far that center slid since then. */
export type PinchStep = (factor: number, clientX: number, clientY: number, dx: number, dy: number) => void;

/**
 * Two fingers on a touch screen, as zoom steps about their center and the
 * distance the center slides, so one gesture both zooms and pans.
 * Safari on iPad reports a pinch as its own gesture events, and cancelling
 * them keeps the page itself from zooming. A trackpad pinch arrives as a
 * ctrl-wheel the surface already reads, so a screen without touch points
 * installs nothing.
 */
export function usePinch(ref: RefObject<HTMLElement | null>, onStep: PinchStep) {
  const step = useRef(onStep);
  useEffect(() => {
    step.current = onStep;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el || navigator.maxTouchPoints === 0) {
      return;
    }

    // Each change carries the total scale since the start; the step is the
    // ratio to the last one, so 1 → 1.2 → 1.5 zooms by 1.2, then by 1.25.
    let last = 1;
    let lastX = 0;
    let lastY = 0;
    const start = (e: Event) => {
      e.preventDefault();
      const g = e as GestureEvent;
      last = 1;
      lastX = g.clientX;
      lastY = g.clientY;
    };
    const change = (e: Event) => {
      e.preventDefault();
      const g = e as GestureEvent;
      if (!g.scale || !last) {
        return;
      }
      step.current(g.scale / last, g.clientX, g.clientY, g.clientX - lastX, g.clientY - lastY);
      last = g.scale;
      lastX = g.clientX;
      lastY = g.clientY;
    };

    el.addEventListener("gesturestart", start);
    el.addEventListener("gesturechange", change);
    el.addEventListener("gestureend", start);
    return () => {
      el.removeEventListener("gesturestart", start);
      el.removeEventListener("gesturechange", change);
      el.removeEventListener("gestureend", start);
    };
  }, [ref]);
}
