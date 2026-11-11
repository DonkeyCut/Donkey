// How much the timeline draws. The editor draws everything. A template's page
// is watched, not edited, so its timeline is light: clips are flat slabs and
// nothing reads the footage for them (no filmstrip sweep, edge frames, tile
// captures or waveforms), and beat dots stay off. Every decoder stays with the
// preview, and the timeline costs what its boxes cost.

import { create } from "zustand";

export type TimelineDetail = "full" | "light";

export const useTimelineDetail = create<{ detail: TimelineDetail }>(() => ({ detail: "full" }));

export const setTimelineDetail = (detail: TimelineDetail) => useTimelineDetail.setState({ detail });

/** The detail right now, for code outside React. */
export const timelineDetail = () => useTimelineDetail.getState().detail;
