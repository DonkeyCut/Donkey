"use client";

import { useEffect } from "react";
import { create } from "zustand";
// The pulse keyframes + ring live in a co-located stylesheet, pulled into the
// client bundle here — the single module every consumer of `genPulseOverlay`
// already imports, so the styles load exactly where the overlay is used.
import "./genNotify.css";

// Long-running work outlives the panel that started it — several renders,
// exports, or transcriptions can run at once while the user edits elsewhere.
// This store is the one place every tab reports that work: while a tab owns
// work in flight its rail tile spins, and a completion that lands unwatched
// badges the tile with a blue count. Opening the tab clears the count and lets
// the freshly-arrived tiles pulse blue for a few seconds so the eye lands on
// them. Media's arrivals are finished exports, keyed by file name.

export type GenTab = "video" | "image" | "audio" | "media" | "subtitles";

export const isGenTab = (v: string): v is GenTab =>
  v === "video" || v === "image" || v === "audio" || v === "media" || v === "subtitles";

/** How long a tab's new tiles keep pulsing once it opens. */
const PULSE_MS = 4500;

/** Overlay for a freshly-arrived tile: a soft blue ring breathing over the
 * media. Drop it as the last child of a `relative overflow-hidden rounded-*`
 * tile. */
export const genPulseOverlay =
  "cut-gen-pulse pointer-events-none absolute inset-0 rounded-[inherit]";

const EMPTY: Record<GenTab, string[]> = {
  video: [],
  image: [],
  audio: [],
  media: [],
  subtitles: [],
};

/** Unique key per registered piece of in-flight work. */
let workSeq = 0;

interface GenNotifyState {
  /** Finished-while-away asset ids per tab — the rail badge counts these. */
  unseen: Record<GenTab, string[]>;
  /** The just-opened tab's arrivals, pulsing until their timer clears them. */
  pulsing: Record<GenTab, string[]>;
  /** In-flight work registered per tab — the rail tile spins while a tab has
   * entries. For work whose running state lives in no store of its own (audio
   * syntheses); tabs with a job store (generate, exports, subtitles) are read
   * directly by the rail. */
  active: Record<GenTab, string[]>;
  /** The generate tab on screen; a completion here needs no badge or pulse —
   *  the user watched the tile appear. */
  watching: GenTab | null;
  landed: (tab: GenTab, assetId: string) => void;
  /** Register a long task with its tab; call the returned function when it
   * settles. Settling after a project switch is a no-op — reset() already
   * dropped the entry. */
  begin: (tab: GenTab) => () => void;
  watch: (tab: GenTab | null) => void;
  endPulse: (tab: GenTab) => void;
  reset: () => void;
}

export const useGenNotify = create<GenNotifyState>((set, get) => ({
  unseen: EMPTY,
  pulsing: EMPTY,
  active: EMPTY,
  watching: null,
  landed: (tab, assetId) => {
    if (get().watching === tab) return; // watched live — no badge, no pulse
    set((s) => ({ unseen: { ...s.unseen, [tab]: [...s.unseen[tab], assetId] } }));
  },
  begin: (tab) => {
    const key = `w${workSeq++}`;
    set((s) => ({ active: { ...s.active, [tab]: [...s.active[tab], key] } }));
    return () =>
      set((s) =>
        s.active[tab].includes(key)
          ? { active: { ...s.active, [tab]: s.active[tab].filter((k) => k !== key) } }
          : {}
      );
  },
  // Opening a tab clears its badge and hands its arrivals to the pulse set, so
  // leaving before the pulse ends never brings the count back — they're seen.
  watch: (tab) =>
    set((s) => {
      if (tab && isGenTab(tab) && s.unseen[tab].length > 0) {
        return {
          watching: tab,
          pulsing: { ...EMPTY, [tab]: s.unseen[tab] },
          unseen: { ...s.unseen, [tab]: [] },
        };
      }
      // Any other switch just drops whatever was pulsing — one tab pulses at a time.
      return { watching: tab, pulsing: EMPTY };
    }),
  endPulse: (tab) =>
    set((s) => (s.pulsing[tab].length === 0 ? {} : { pulsing: { ...s.pulsing, [tab]: [] } })),
  reset: () => set({ unseen: EMPTY, pulsing: EMPTY, active: EMPTY }),
}));

/** Whether this finished tile is in its tab's fresh-arrival pulse. */
export function useGenPulse(tab: GenTab, assetId?: string): boolean {
  return useGenNotify((s) => (assetId ? s.pulsing[tab].includes(assetId) : false));
}

/** Wire the side rail in: track which generate tab is open (so its completions
 * skip the badge), and let its fresh tiles pulse for a few seconds after it
 * opens. A project switch drops everything — the tiles belong to the project
 * that made them. */
export function useWatchGenTab(tab: string | null, projectId: string) {
  const genTab = tab != null && isGenTab(tab) ? tab : null;
  const pulsing = useGenNotify((s) => (genTab ? s.pulsing[genTab].length > 0 : false));
  useEffect(() => {
    useGenNotify.getState().reset();
  }, [projectId]);
  useEffect(() => {
    useGenNotify.getState().watch(genTab);
    return () => useGenNotify.getState().watch(null);
  }, [genTab]);
  useEffect(() => {
    if (!genTab || !pulsing) return;
    const t = setTimeout(() => useGenNotify.getState().endPulse(genTab), PULSE_MS);
    return () => clearTimeout(t);
  }, [genTab, pulsing]);
}
