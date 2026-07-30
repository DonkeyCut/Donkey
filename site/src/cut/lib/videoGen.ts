"use client";

import { create } from "zustand";
import { addRefOnce, sameRef, upsertRef, type AssetRef } from "./assetRef";
import type { StockVideo } from "./stock";
import type { VideoAspect } from "./videoModels";

// The generate-video panel's state, shared between the stock-video browser
// (which loads a stock clip's saved prompt into it on click) and the always-on
// generate panel that sits beside the browser in the Video tab.

interface VideoGenState {
  prompt: string;
  /** The shape the next generation is composed in. */
  aspect: VideoAspect;
  /** Visual references attached to the next generation (dragged in or picked
   * via @name mentions resolved on send). */
  refs: AssetRef[];
  /** Character mode: the picked talking character. The panel's text is the
   * line they speak, composed with the character's persona on send; null is
   * free-form prompting. */
  character: StockVideo | null;
  /** Load a starting prompt into the panel (a stock clip's saved prompt, or
   * "" for a blank generation). Resets references and leaves character mode. */
  openWith: (prompt: string) => void;
  /** Enter character mode for a stock talking character. */
  openCharacter: (character: StockVideo) => void;
  clearCharacter: () => void;
  setPrompt: (prompt: string) => void;
  setAspect: (aspect: VideoAspect) => void;
  addRef: (ref: AssetRef) => void;
  /** Land a ref's new shape — replaced in place when attached, attached when
   * not — how the moment picker lands a pinned timestamp from a chip or a
   * typed mention. */
  updateRef: (ref: AssetRef) => void;
  removeRef: (ref: AssetRef) => void;
}

export const useVideoGen = create<VideoGenState>((set) => ({
  prompt: "",
  aspect: "16:9",
  refs: [],
  character: null,
  openWith: (prompt) => set({ prompt, refs: [], character: null }),
  openCharacter: (character) => set({ character, prompt: "", refs: [] }),
  clearCharacter: () => set({ character: null }),
  setPrompt: (prompt) => set({ prompt }),
  setAspect: (aspect) => set({ aspect }),
  addRef: (ref) => set((s) => ({ refs: addRefOnce(s.refs, ref) })),
  updateRef: (ref) => set((s) => ({ refs: upsertRef(s.refs, ref) })),
  removeRef: (ref) => set((s) => ({ refs: s.refs.filter((r) => !sameRef(r, ref)) })),
}));
