// How much the timeline draws. The editor draws everything. A template's page
// is watched, not edited, so its timeline is light: each video clip shows the
// first frame the template baked for it, tiled across the clip, its sound
// draws from peaks baked beside them, and nothing reads the footage (no
// filmstrip sweep, edge frames or tile captures); beat dots stay off. The decoders stay with the preview.

import { create } from "zustand";

export type TimelineDetail = "full" | "light";

/** Where a light timeline finds a video clip's baked first frame. */
export type ClipFrame = (clipId: string) => string;

export const useTimelineDetail = create<{ detail: TimelineDetail; frame: ClipFrame | null }>(() => ({
  detail: "full",
  frame: null,
}));

/** A light timeline, its clips drawn from their baked frames. */
export const setLightTimeline = (frame: ClipFrame) => useTimelineDetail.setState({ detail: "light", frame });

/** The editor's full timeline. */
export const setFullTimeline = () => useTimelineDetail.setState({ detail: "full", frame: null });

/** The detail right now, for code outside React. */
export const timelineDetail = () => useTimelineDetail.getState().detail;
