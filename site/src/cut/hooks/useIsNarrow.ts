"use client";

import { useEffect, useState } from "react";

/** The width below which the editor stops being worth opening. It still lays
 * out down here — the panels give up width, the top bar folds its buttons into
 * a menu, the chat panel overlays rather than docking — but its fixed chrome
 * leaves the preview so little room that there is nothing left to edit with. */
export const NARROW_MAX_WIDTH = 900;

/**
 * Whether the viewport is too narrow for the editor — null until known.
 *
 * The site's styling rule is to branch on Tailwind's responsive variants rather
 * than a media-query hook, and that holds wherever the question is how
 * something looks. This one decides what MOUNTS: the editor's playback builds a
 * video decoder per clip, so hiding it with a class would still start every
 * decode on a phone that cannot afford one. That has to be a JS branch.
 *
 * The null state is why the return type is not a plain boolean. A hook that
 * guessed false first would mount the editor for a frame on a phone, which is
 * exactly the cost this exists to avoid — the guess is not free the way a
 * mis-guessed CSS class would be. Callers wait it out instead.
 */
export function useIsNarrow(): boolean | null {
  const [narrow, setNarrow] = useState<boolean | null>(null);
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${NARROW_MAX_WIDTH - 1}px)`);
    const sync = () => setNarrow(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return narrow;
}

/**
 * The viewport's narrowness measured once, when the component opens — null
 * only on the server. For mount decisions that must hold for the visit: the
 * share view picks its surface (player or editor) by this, and a desktop
 * window resized across the threshold keeps the surface it opened with —
 * following the live width would tear down a playing editor and reload the
 * whole project mid-drag.
 */
export function useIsNarrowAtOpen(): boolean | null {
  const [narrow] = useState<boolean | null>(() =>
    typeof window === "undefined"
      ? null
      : window.matchMedia(`(max-width: ${NARROW_MAX_WIDTH - 1}px)`).matches
  );
  return narrow;
}
