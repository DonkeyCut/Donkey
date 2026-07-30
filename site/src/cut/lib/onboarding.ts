// One contract shared by the settings row that replays the welcome sequence
// and the overlay mounted in the app shell that shows it. The overlay is
// mounted once, high in the tree; anything that wants it opens it from here.

import { create } from "zustand";

const EVENT = "cut-onboarding-open";

/** Whether the welcome sequence is covering the window right now. The starter
 * project's first open waits on this before starting playback, so its music
 * bed never plays under the slides. */
export const useOnboardingCover = create<{ up: boolean }>(() => ({ up: false }));

export const setOnboardingCover = (up: boolean) => useOnboardingCover.setState({ up });

export function openOnboarding(): void {
  window.dispatchEvent(new Event(EVENT));
}

export function onOpenOnboarding(handler: () => void): () => void {
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
