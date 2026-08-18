"use client";

import { create } from "zustand";

/**
 * What the tab is busy with.
 *
 * Work in Cut outlives the click that started it — a chat turn streams, a
 * render runs, an import lands — and the user is often reading another tab
 * while it happens. Anything that takes a while says so here, and the tab's
 * own icon and title carry it (`components/TabStatus.tsx`).
 */
export type ActivityKind = "chat" | "generate" | "render" | "export" | "transcribe" | "import";

interface TabActivityState {
  running: Partial<Record<ActivityKind, boolean>>;
  /** Say whether this kind of work is under way right now. */
  setRunning: (kind: ActivityKind, on: boolean) => void;
}

export const useTabActivity = create<TabActivityState>((set) => ({
  running: {},
  setRunning: (kind, on) =>
    set((s) => (!!s.running[kind] === on ? s : { running: { ...s.running, [kind]: on } })),
}));

export const busyIn = (running: Partial<Record<ActivityKind, boolean>>): boolean =>
  Object.values(running).some(Boolean);

/** Report a piece of work for as long as `on` holds. */
export const reportActivity = (kind: ActivityKind, on: boolean): void =>
  useTabActivity.getState().setRunning(kind, on);
