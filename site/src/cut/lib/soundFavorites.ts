"use client";

import { create } from "zustand";

// The sounds a person starred on the Effects tab's Sound shelf, by stock id,
// newest first. Kept in this browser: a favorite is a shortcut back to a
// sound, and the sounds themselves ship with the editor everywhere.

const KEY = "cut-sound-favorites";

function load(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

interface SoundFavorites {
  ids: string[];
  toggle: (id: string) => void;
}

export const useSoundFavorites = create<SoundFavorites>((set, get) => ({
  ids: load(),
  toggle: (id) => {
    const ids = get().ids.includes(id) ? get().ids.filter((x) => x !== id) : [id, ...get().ids];
    set({ ids });
    try {
      localStorage.setItem(KEY, JSON.stringify(ids));
    } catch {
      // Private-mode quota — the star just won't stick across reloads.
    }
  },
}));
