"use client";

import { create } from "zustand";

/**
 * Which clip's speed curve is open in the strip over the timeline, if any.
 * The Inspector's Speed row opens it, the strip closes itself, and any
 * selection that leaves the clip closes it too.
 */
interface SpeedCurveUi {
  clipId: string | null;
  open: (clipId: string) => void;
  close: () => void;
}

export const useSpeedCurveUi = create<SpeedCurveUi>((set) => ({
  clipId: null,
  open: (clipId) => set({ clipId }),
  close: () => set({ clipId: null }),
}));
