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

/** Where the template tour runs: the project a template was just copied
 * into, or a template project whose ? asked for it again. A copy cues run 0,
 * which runs only while the account has tours left; each ? ask is a new run
 * that always does. A run that ends takes the cue away, so opening the
 * project again never repeats it. */
export const useTemplateTourCue = create<{ projectId: string | null; run: number }>(() => ({
  projectId: null,
  run: 0,
}));

export const cueTemplateTour = (projectId: string) => useTemplateTourCue.setState({ projectId, run: 0 });

export const replayTemplateTour = (projectId: string) =>
  useTemplateTourCue.setState((s) => ({ projectId, run: s.run + 1 }));

export const endTemplateTour = () => useTemplateTourCue.setState({ projectId: null });

export function openOnboarding(): void {
  window.dispatchEvent(new Event(EVENT));
}

export function onOpenOnboarding(handler: () => void): () => void {
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

/** What the starter tour waits on that the editor store doesn't hold: the side
 * panel's open tab, which lives in the panel's own state. The panel reports
 * here; the tour reads. `hold` is the tour's own pause after a step,
 * while the person watches what their action did: the next step and the plans
 * both wait it out. It carries a token, so a pause only ends itself. */
export const useTourSignals = create<{
  sideTab: string | null;
  hold: number | null;
}>(() => ({
  sideTab: null,
  hold: null,
}));

export const reportSideTab = (sideTab: string | null) => useTourSignals.setState({ sideTab });

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
