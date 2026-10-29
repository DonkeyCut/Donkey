// Where an account stands on the way in, read off its onboarding row: the
// slides, the starter tour, the plans that close it, or done. The overlay, the
// tour, the plans dialog and the project lock all derive from this one answer.

import { ONBOARDING_VERSION, TOUR_STEPS, type TourStep } from "@/lib/onboarding/sequence";

export type OnboardingStage = "slides" | "tour" | "plans" | "done";

type StageFields = {
  version: number;
  completedAt: string | null;
  slidesDoneAt: string | null;
  tourSteps: string[];
  starterReady: boolean;
};

/** Whether this account still owes us a run of the current sequence. */
export function needsOnboarding(state: StageFields | undefined): boolean {
  if (!state) {
    return false;
  }
  return state.completedAt === null || state.version < ONBOARDING_VERSION;
}

/** The stage this account is at, or null while the read is in flight. The tour
 * needs the starter project; an account without one goes on to the plans. */
export function onboardingStage(state: StageFields | undefined): OnboardingStage | null {
  if (!state) {
    return null;
  }
  if (!needsOnboarding(state)) {
    return "done";
  }
  if (state.slidesDoneAt === null) {
    return "slides";
  }
  if (state.starterReady && nextTourStep(state) !== null) {
    return "tour";
  }
  return "plans";
}

/** The first tour step this account has yet to do, or null when all are done. */
export function nextTourStep(state: Pick<StageFields, "tourSteps">): TourStep | null {
  return TOUR_STEPS.find((step) => !state.tourSteps.includes(step)) ?? null;
}
