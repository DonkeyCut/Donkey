"use client";

import { useRef, type PointerEvent } from "react";

/** Whether hover playback unmutes: a preview with sound, or a silent loop. */
export type HoverAudio = "sound" | "silent";

type HoverMove = Pick<PointerEvent, "pointerType" | "movementX" | "movementY">;

/**
 * A hover is the person moving a mouse over a focused page. Browsers also send
 * pointer events to an unfocused window under the cursor and when layout slides
 * a tile under a parked pointer (a render landing in chat); neither may start
 * a preview, least of all one with sound.
 */
export function isRealHover(e: HoverMove, focused: boolean) {
  if (!focused || e.pointerType === "touch") {
    return false;
  }
  return e.movementX !== 0 || e.movementY !== 0;
}

/**
 * Hover-to-play for a muted <video> poster: moving over it plays (with sound
 * when asked; if the browser refuses sound, playback falls back to silent),
 * leaving pauses, re-mutes, and returns to `restTime`. Attach `ref` to the
 * <video> and spread `handlers` on the hover target (the tile, not the video,
 * so scrims stay hoverable).
 */
export function useHoverPlay(restTime = 0.1, audio: HoverAudio = "sound") {
  const ref = useRef<HTMLVideoElement>(null);
  const handlers = {
    onPointerMove: (e: PointerEvent) => {
      const v = ref.current;
      if (!v || !v.paused || !isRealHover(e, document.hasFocus())) {
        return;
      }
      v.muted = audio === "silent";
      void v.play().catch(() => {
        v.muted = true;
        void v.play().catch(() => {});
      });
    },
    onPointerLeave: () => {
      const v = ref.current;
      if (!v) {
        return;
      }
      v.pause();
      v.muted = true;
      v.currentTime = restTime;
    },
  };
  return { ref, handlers };
}
