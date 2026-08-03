"use client";

/**
 * The generated asset a user has picked, shared by every generation tab.
 *
 * Picking is what a click on a tile means — in the Elements, Image and Video
 * tabs alike. It is deliberately not "use this now": a click used to add a
 * sticker straight to the timeline, which made browsing what you had made an
 * edit. Adding, expanding, copying and deleting are the tile's own buttons;
 * the click just says which one you mean.
 *
 * One picked id across all the tabs, so picking in one clears the last.
 */

import { create } from "zustand";

interface PickedAsset {
  id: string | null;
  /** Pick `id`, or unpick it when it is already the picked one. */
  pick: (id: string) => void;
  clear: () => void;
}

export const usePickedAsset = create<PickedAsset>((set) => ({
  id: null,
  pick: (id) => set((s) => ({ id: s.id === id ? null : id })),
  clear: () => set({ id: null }),
}));

/** Whether this tile is the picked one, and the click that toggles it. */
export function useAssetPick(assetId: string): { picked: boolean; pick: () => void } {
  const picked = usePickedAsset((s) => s.id) === assetId;
  return { picked, pick: () => usePickedAsset.getState().pick(assetId) };
}

/** The ring a picked tile wears. One class string so the tabs cannot drift. */
export const PICKED_RING = "ring-2 ring-[#0a84ff] ring-offset-1 ring-offset-card";

/** Arrow-key navigation across a grid of pickable tiles. Mark each tile's
 * button with `data-pick-id` and put this handler on the grid container: while
 * the pick (or focus) is in the grid, an arrow clicks the neighboring tile, so
 * keyboard moves carry the exact click semantics — picking, or retuning a
 * selected element. The column count is read off the rendered rows, so one
 * handler serves every grid width. Arrows are swallowed here either way; the
 * editor's window-level seek must not fire while the keyboard is on tiles. */
export function pickGridNav(e: React.KeyboardEvent<HTMLElement>) {
  if (!e.key.startsWith("Arrow") || e.metaKey || e.ctrlKey || e.altKey) return;
  const tiles = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-pick-id]"));
  if (tiles.length === 0) return;
  const picked = usePickedAsset.getState().id;
  let from = tiles.findIndex((t) => t.dataset.pickId === picked);
  if (from < 0)
    from = tiles.findIndex(
      (t) => t === document.activeElement || t.contains(document.activeElement)
    );
  if (from < 0) return;
  e.preventDefault();
  e.stopPropagation();
  const cols = tiles.filter((t) => t.offsetTop === tiles[0].offsetTop).length;
  const step =
    e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" ? -cols : cols;
  const to = from + step;
  if (to < 0 || to >= tiles.length) return;
  tiles[to].click();
  tiles[to].focus();
}
