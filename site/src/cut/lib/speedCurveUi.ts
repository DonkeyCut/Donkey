"use client";

import { create } from "zustand";

/**
 * Which clips have their speed curve open in the strip over the timeline.
 * The Inspector's Speed row opens a clip's curve and the strip closes it.
 * Every clip keeps its own state: selecting another clip hides the strip
 * and leaves the curve open, so coming back to the clip brings the graph
 * back until it is closed. A clip going away drops its entry.
 */
interface SpeedCurveUi {
  open: ReadonlySet<string>;
  openFor: (clipId: string) => void;
  close: (clipId: string) => void;
}

export const useSpeedCurveUi = create<SpeedCurveUi>((set) => ({
  open: new Set(),
  openFor: (clipId) => set((s) => ({ open: new Set(s.open).add(clipId) })),
  close: (clipId) =>
    set((s) => {
      if (!s.open.has(clipId)) return s;
      const open = new Set(s.open);
      open.delete(clipId);
      return { open };
    }),
}));
