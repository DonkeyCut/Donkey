"use client";

import { create } from "zustand";
import { addRefOnce, sameRef, upsertRef, type AssetRef } from "./assetRef";

// The generate-image panel's state, shared between the stock browser (which
// loads a stock image's saved prompt into it on click) and the always-on
// generate panel that sits beside the browser in the Image tab.

/** The shape the next generated image is composed in. */
export type ImageAspect = "16:9" | "9:16" | "1:1";

/** Every shape the image model renders — the registry list AI-path defaults
 * and panel seeds clamp the project aspect onto. */
export const IMAGE_ASPECTS: readonly ImageAspect[] = ["16:9", "9:16", "1:1"];

export const IMAGE_ASPECT_LABEL: Record<ImageAspect, string> = {
  "16:9": "Landscape (16:9)",
  "9:16": "Portrait (9:16)",
  "1:1": "Square (1:1)",
};

/** Output detail for the next generation. The image model maps these to real
 * pixel sizes (1K ≈ 1MP, 2K ≈ 4MP, 4K ≈ 16MP). */
export type ImageResolution = "1K" | "2K" | "4K";

export const IMAGE_RESOLUTION_LABEL: Record<ImageResolution, string> = {
  "1K": "1K",
  "2K": "2K",
  "4K": "4K",
};

interface ImageGenState {
  prompt: string;
  /** The shape the next generation is composed in. */
  aspect: ImageAspect;
  /** The output detail the next generation renders at. */
  resolution: ImageResolution;
  /** Visual references attached to the next generation (dragged in or picked
   * via @name mentions resolved on send). */
  refs: AssetRef[];
  /** Load a starting prompt into the panel (a stock image's saved prompt, or
   * "" for a blank generation). Resets any attached references. */
  openWith: (prompt: string) => void;
  setPrompt: (prompt: string) => void;
  setAspect: (aspect: ImageAspect) => void;
  setResolution: (resolution: ImageResolution) => void;
  addRef: (ref: AssetRef) => void;
  /** Land a ref's new shape — replaced in place when attached, attached when
   * not — how the moment picker lands a pinned timestamp from a chip or a
   * typed mention. */
  updateRef: (ref: AssetRef) => void;
  removeRef: (ref: AssetRef) => void;
}

export const useImageGen = create<ImageGenState>((set) => ({
  prompt: "",
  aspect: "9:16",
  resolution: "2K",
  refs: [],
  openWith: (prompt) => set({ prompt, refs: [] }),
  setPrompt: (prompt) => set({ prompt }),
  setAspect: (aspect) => set({ aspect }),
  setResolution: (resolution) => set({ resolution }),
  addRef: (ref) => set((s) => ({ refs: addRefOnce(s.refs, ref) })),
  updateRef: (ref) => set((s) => ({ refs: upsertRef(s.refs, ref) })),
  removeRef: (ref) => set((s) => ({ refs: s.refs.filter((r) => !sameRef(r, ref)) })),
}));
