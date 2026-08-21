"use client";

import { create } from "zustand";
import type { AssetRef } from "./assetRef";
import { libraryMediaUrl, libraryPosterUrl, type LibraryAsset } from "./library";

// The asset lightbox: a full-screen viewer opened from stock tiles, generated
// media, chat asset cards, and library cards. Held in its own store so any
// surface can open it and a single mounted overlay renders it.

export interface LightboxItem {
  kind: "video" | "image" | "audio" | "text" | "font";
  /** Fetchable source for the media or file. */
  src: string;
  name: string;
  /** The generation prompt, when known. */
  prompt: string;
  /** Width ÷ height, when known — sizes the viewer up front so it opens at the
   * media's own shape instead of collapsing until the file's metadata loads. */
  ratio?: number;
  /** A cover image to show while the media loads: the source's own thumbnail
   * for an imported clip. */
  poster?: string;
  /** For a project asset, its id (add straight to the timeline); null for a
   * stock or library item, which the lightbox imports first. */
  assetId: string | null;
  /** For a library asset, its id — "Use" copies it in through the library
   * route so it files like any other library use, not as stock. */
  libraryId?: string;
  /** Show the media alone, without the name, prompt, or "Use" button. The
   * library page opens this way: outside the editor there is no project to
   * add anything to. */
  bare?: boolean;
}

/** The lightbox view of an asset ref — how chat cards and attachment chips
 * open the big version of whatever they show. */
export const lightboxItemFromRef = (ref: AssetRef): LightboxItem => ({
  kind: ref.kind,
  src: ref.url,
  name: ref.name,
  prompt: "",
  ...(ref.width && ref.height ? { ratio: ref.width / ref.height } : {}),
  ...(ref.thumb ? { poster: ref.thumb } : {}),
  assetId: ref.scope === "project" ? ref.id : null,
  ...(ref.scope === "library" ? { libraryId: ref.id } : {}),
});

/** The lightbox view of a library asset — what a library card opens on a
 * double-click. `bare` where the surface has no project to add anything to. */
export const lightboxItemFromLibrary = (
  a: LibraryAsset,
  bare = false,
): LightboxItem => ({
  kind: a.type,
  src: libraryMediaUrl(a.fileName, a.residency),
  name: a.name,
  prompt: "",
  assetId: null,
  libraryId: a.id,
  ...(bare ? { bare: true } : {}),
  ...(a.width && a.height ? { ratio: a.width / a.height } : {}),
  ...(libraryPosterUrl(a) ? { poster: libraryPosterUrl(a) } : {}),
});

interface LightboxState {
  item: LightboxItem | null;
  open: (item: LightboxItem) => void;
  close: () => void;
}

export const useLightbox = create<LightboxState>((set) => ({
  item: null,
  open: (item) => set({ item }),
  close: () => set({ item: null }),
}));
