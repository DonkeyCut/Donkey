"use client";

import { useEffect } from "react";
import { create } from "zustand";

// The assistant's set_side_panel tool and the doc's firstOpen block land
// here: a one-shot request the SidePanel applies — open a tab, or collapse
// the panel to the icon rail so the preview canvas takes the freed width.

import type { SidePanelTab } from "./types";

export const SIDE_PANEL_TABS: SidePanelTab[] = [
  "media",
  "library",
  "elements",
  "effects",
  "transitions",
  "video",
  "image",
  "audio",
  "subtitles",
  "publish",
];

interface PanelRequestState {
  target: SidePanelTab | null;
  /** Bumps per request so repeating the same target still fires the effect. */
  seq: number;
  /** Timestamp of the request; the effect ignores stale targets on remount. */
  at: number;
  request: (tab: SidePanelTab | null) => void;
}

const usePanelRequest = create<PanelRequestState>((set) => ({
  target: null,
  seq: 0,
  at: 0,
  request: (tab) => set((s) => ({ target: tab, seq: s.seq + 1, at: Date.now() })),
}));

export const requestSidePanel = (tab: SidePanelTab | null) =>
  usePanelRequest.getState().request(tab);

/** How long a request stays actionable — survives the current render pass,
 * short enough that a later remount doesn't replay it. */
const FRESH_MS = 3000;

/** SidePanel-side handling: applies each fresh request to its tab state. */
export function usePanelRequestEffect(apply: (tab: SidePanelTab | null) => void) {
  const seq = usePanelRequest((s) => s.seq);
  useEffect(() => {
    if (!seq) return;
    const { target, at } = usePanelRequest.getState();
    if (Date.now() - at > FRESH_MS) return;
    apply(target);
    // Re-run on each request only; the callback is read fresh per firing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq]);
}
