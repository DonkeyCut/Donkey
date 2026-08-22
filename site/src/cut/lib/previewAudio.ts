"use client";

import { create } from "zustand";

// One shared preview player for every "play this audio" affordance — Audio
// panel rows and chat audio cards. Starting a preview stops the last one, and
// every surface reads the same playing-url state, so previews never stack.

interface PreviewAudioState {
  /** URL of the preview currently playing, or null. */
  url: string | null;
  /** Play `url`, stopping whatever else was playing; pause when it is already
   * the one playing. */
  toggle: (url: string) => void;
  /** Stop the preview — entirely, or only when it is playing `url` (a surface
   * going away should silence its own preview, not someone else's). */
  stop: (url?: string) => void;
}

let el: HTMLAudioElement | null = null;

/** Other players that have to go quiet when a preview starts. The effect
 * auditions run on their own audio graph rather than this element, and two
 * things playing at once teaches nothing about either. */
const silencers = new Set<() => void>();

export function registerPreviewSilencer(stop: () => void): () => void {
  silencers.add(stop);
  return () => {
    silencers.delete(stop);
  };
}

export const usePreviewAudio = create<PreviewAudioState>((set, get) => ({
  url: null,
  toggle: (url) => {
    for (const stop of silencers) stop();
    const audio = (el ??= new Audio());
    if (get().url === url) {
      audio.pause();
      set({ url: null });
      return;
    }
    audio.src = url;
    audio.onended = () => set({ url: null });
    // Only the load that still owns the state may clear it — a superseded load's
    // late error/rejection must not knock out the preview playing now.
    audio.onerror = () => {
      if (get().url === url) set({ url: null });
    };
    set({ url });
    void audio.play().catch(() => {
      if (get().url === url) set({ url: null });
    });
  },
  stop: (url) => {
    if (url !== undefined && get().url !== url) return;
    el?.pause();
    set({ url: null });
  },
}));
