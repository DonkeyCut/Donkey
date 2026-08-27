"use client";

import { create } from "zustand";

/**
 * Session memory for settings panels: which view each timeline element's
 * panel was left on, keyed per element. Deselecting a segment to look at
 * something and selecting it again lands back on its own view; an element
 * whose panel was never opened starts at the default. In-memory only — a
 * reload starts fresh.
 */
const usePanelViews = create<{
  views: Record<string, string>;
  set: (key: string, view: string) => void;
}>((set) => ({
  views: {},
  set: (key, view) => set((s) => ({ views: { ...s.views, [key]: view } })),
}));

/** A `useState` whose value holds for the session under `key`. */
export function usePanelView<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const value = (usePanelViews((s) => s.views[key]) as T | undefined) ?? initial;
  const set = usePanelViews((s) => s.set);
  return [value, (v: T) => set(key, v)];
}
