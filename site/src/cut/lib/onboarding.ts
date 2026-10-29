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

/** What the starter tour waits on that the editor store doesn't hold: the side
 * panel's open tab, which lives in the panel's own state, whether a chat
 * message went out, and whether a chat turn is running. The panel and the chat
 * report here; the tour reads. `hold` is the tour's own pause after a step,
 * while the person watches what their action did: the next step and the plans
 * both wait it out. It carries a token, so a pause only ends itself. */
export const useTourSignals = create<{
  sideTab: string | null;
  chatSent: boolean;
  chatRunning: boolean;
  hold: number | null;
}>(() => ({
  sideTab: null,
  chatSent: false,
  chatRunning: false,
  hold: null,
}));

export const reportSideTab = (sideTab: string | null) => useTourSignals.setState({ sideTab });

export const reportChatSent = () => useTourSignals.setState({ chatSent: true });

export const reportChatRunning = (chatRunning: boolean) => useTourSignals.setState({ chatRunning });

let fillComposer: ((text: string) => void) | null = null;

/** Registers the chat composer the tour types into; returns the release. */
export function onComposerFill(handler: (text: string) => void): () => void {
  fillComposer = handler;
  return () => {
    if (fillComposer === handler) {
      fillComposer = null;
    }
  };
}

/** Sets the chat composer's text, as the tour types its example message. */
export const fillChatComposer = (text: string) => fillComposer?.(text);

let holdSeq = 0;

/** Starts a pause; returns the token that ends it. */
export function holdTour(): number {
  holdSeq += 1;
  useTourSignals.setState({ hold: holdSeq });
  return holdSeq;
}

/** Ends the pause the token started, if it is still the one running. */
export function releaseTour(token: number): void {
  if (useTourSignals.getState().hold === token) {
    useTourSignals.setState({ hold: null });
  }
}
