"use client";

import { useCallback, type UIEvent } from "react";
import { create } from "zustand";

import { useEditor } from "./store";

/**
 * The settings panel's memory. Every piece of view state a panel keeps for a
 * timeline item — the rail tab it was left on, the view inside that tab, the
 * tool in hand, a toggle, how far it was scrolled — is stored here under the
 * item's id and a field name, so selecting something else and coming back
 * lands on the panel exactly as it was left. State that belongs to no single
 * item (the subtitles tab) sits under `PANEL_GLOBAL`.
 *
 * Panels read through `usePanelState` where React needs to re-render and
 * through `panelState` where an event handler needs the value right now.
 * Scroll offsets take the second path on every scroll event, so they cost no
 * render. In-memory only — a reload starts fresh — and an item's entries go
 * with it when it leaves the document.
 */

/** The id under which state that is not about one item is kept. */
export const PANEL_GLOBAL = "global";

type Fields = Record<string, unknown>;

interface PanelStore {
  items: Record<string, Fields>;
  set: (item: string, field: string, value: unknown) => void;
  forget: (keep: (item: string) => boolean) => void;
}

export const usePanelStore = create<PanelStore>((set) => ({
  items: {},
  set: (item, field, value) =>
    set((s) => {
      if (s.items[item]?.[field] === value) return s;
      return { items: { ...s.items, [item]: { ...s.items[item], [field]: value } } };
    }),
  forget: (keep) =>
    set((s) => {
      const items: Record<string, Fields> = {};
      let dropped = false;
      for (const [item, fields] of Object.entries(s.items)) {
        if (keep(item)) items[item] = fields;
        else dropped = true;
      }
      return dropped ? { items } : s;
    }),
}));

/** The memory as plain reads and writes, for handlers and effects. */
export const panelState = {
  get<T>(item: string, field: string, initial: T): T {
    const v = usePanelStore.getState().items[item]?.[field];
    return v === undefined ? initial : (v as T);
  },
  set(item: string, field: string, value: unknown): void {
    usePanelStore.getState().set(item, field, value);
  },
};

/** A `useState` whose value holds for the session under the item and field. */
export function usePanelState<T>(item: string, field: string, initial: T): [T, (v: T) => void] {
  const stored = usePanelStore((s) => s.items[item]?.[field]);
  const set = useCallback((v: T) => panelState.set(item, field, v), [item, field]);
  return [stored === undefined ? initial : (stored as T), set];
}

/**
 * Scroll memory for a panel's scroller: the viewport lands where it was left
 * and every scroll writes the new offset. Spread the result onto a
 * `ScrollArea`. A scroller that shows a different list per tab keys itself
 * on the tab and names the tab in `field`, so each list keeps its own place.
 */
export function useRememberedScroll(item: string, field: string) {
  const key = `scroll:${field}`;
  const viewportRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (node) node.scrollTop = panelState.get(item, key, 0);
    },
    [item, key]
  );
  const onViewportScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => panelState.set(item, key, e.currentTarget.scrollTop),
    [item, key]
  );
  return { viewportRef, onViewportScroll };
}

// An item that leaves the document takes its memory with it. Deleting is the
// only edit that shrinks the element count, so the sweep runs only then, and
// on a project switch; a drag or a trim never pays for it.
let lastCount = -1;
let lastProject: string | null = null;
useEditor.subscribe((s) => {
  const count = s.clips.length + s.audioClips.length + s.overlays.length;
  const switched = s.projectId !== lastProject;
  const shrank = lastCount >= 0 && count < lastCount;
  lastCount = count;
  lastProject = s.projectId;
  if (!switched && !shrank) return;
  const live = new Set<string>([PANEL_GLOBAL]);
  for (const c of s.clips) live.add(c.id);
  for (const c of s.audioClips) live.add(c.id);
  for (const o of s.overlays) live.add(o.id);
  usePanelStore.getState().forget((item) => live.has(item));
});
