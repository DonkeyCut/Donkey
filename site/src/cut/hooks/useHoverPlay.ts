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

/** The tile previewing on hover right now, and how it goes back to rest. */
let hovering: { video: HTMLVideoElement; rest: () => void } | null = null;

/**
 * A preview stops when the window goes away. The pointer never leaves a tile
 * in a window that was minimized or switched from, so without this the clip
 * keeps playing behind it, sound and all.
 */
function restOnLeave() {
  hovering?.rest();
  hovering = null;
}

function startHover(video: HTMLVideoElement, rest: () => void) {
  hovering = { video, rest };
}

function endHover(video: HTMLVideoElement) {
  if (hovering?.video === video) {
    hovering = null;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("blur", restOnLeave);
  document.addEventListener("visibilitychange", restOnLeave);
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
      // A tile preview is never the page's video: the browser's automatic
      // picture-in-picture would float it once the window goes away.
      v.disablePictureInPicture = true;
      startHover(v, () => rest(v));
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
      endHover(v);
      rest(v);
    },
  };

  // Paused, silent, back on the poster frame.
  function rest(v: HTMLVideoElement) {
    v.pause();
    v.muted = true;
    v.currentTime = restTime;
  }
  return { ref, handlers };
}
