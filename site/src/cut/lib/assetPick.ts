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
