"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ONBOARDING_VERSION, type ReferralSource, type TourStep } from "@/lib/onboarding/sequence";
import { apiFetch } from "@/queries/apiClient";

export const onboardingQueryKey = ["account-onboarding"] as const;

export type OnboardingState = {
  version: number;
  completedAt: string | null;
  skipped: boolean;
  slidesDoneAt: string | null;
  tourSteps: string[];
  starterReady: boolean;
  referralSources: string[];
  referralOther: string | null;
  signupCredits: string | null;
  signupCreditsExpiresAt: string | null;
};

type OnboardingUpdate =
  | { referralSources: ReferralSource[]; referralOther?: string }
  | { completed: true; skipped: boolean }
  | { slidesDone: true }
  | { restart: true }
  | { tourStep: TourStep };

/** The account's onboarding row as it stands now. */
export async function fetchOnboardingState(): Promise<OnboardingState> {
  return readState(await apiFetch<Partial<OnboardingState>>("/api/account/onboarding"));
}

export function useOnboardingState() {
  return useQuery({
    queryFn: fetchOnboardingState,
    queryKey: onboardingQueryKey,
    // The sequence decides once per load whether to open; refetching behind an
    // open overlay could only close it mid-run.
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useSaveOnboarding() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (update: OnboardingUpdate) =>
      readState(
        await apiFetch<Partial<OnboardingState>>("/api/account/onboarding", {
          body: JSON.stringify(update),
          method: "PUT",
        }),
      ),
    // The stage moves the moment a step lands, so the tour, the project lock
    // and the plans follow the person without waiting on the write.
    onMutate: (update) => {
      queryClient.setQueryData<OnboardingState>(onboardingQueryKey, (state) => state && applyUpdate(state, update));
    },
    // Progress only moves forward, so a reply that left the server before a
    // later write keeps what that write already put here. A restart's reply is
    // the account row as it starts over.
    onSuccess: (state, update) => {
      queryClient.setQueryData<OnboardingState>(onboardingQueryKey, (prev) =>
        prev && !("restart" in update)
          ? {
              ...state,
              slidesDoneAt: state.slidesDoneAt ?? prev.slidesDoneAt,
              completedAt: state.completedAt ?? prev.completedAt,
              tourSteps: [...new Set([...prev.tourSteps, ...state.tourSteps])],
            }
          : state,
      );
    },
    // A write that failed hands the stage back to the account row.
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: onboardingQueryKey });
    },
  });
}

// The account's answer with every field present: a server from before the tour
// sends no tour fields, and reads as an account with nothing toured.
function readState(state: Partial<OnboardingState>): OnboardingState {
  return {
    version: state.version ?? ONBOARDING_VERSION,
    completedAt: state.completedAt ?? null,
    skipped: state.skipped ?? false,
    slidesDoneAt: state.slidesDoneAt ?? null,
    tourSteps: state.tourSteps ?? [],
    starterReady: state.starterReady ?? false,
    referralSources: state.referralSources ?? [],
    referralOther: state.referralOther ?? null,
    signupCredits: state.signupCredits ?? null,
    signupCreditsExpiresAt: state.signupCreditsExpiresAt ?? null,
  };
}

// What the account row will say once the write lands.
function applyUpdate(state: OnboardingState, update: OnboardingUpdate): OnboardingState {
  // The server seeds the starter as the slides end, so the stage moves on to
  // the tour; the starter itself opens once the reply lands.
  if ("slidesDone" in update) {
    return { ...state, slidesDoneAt: new Date().toISOString(), starterReady: true };
  }
  if ("restart" in update) {
    return {
      ...state,
      completedAt: null,
      skipped: false,
      slidesDoneAt: new Date().toISOString(),
      starterReady: true,
      tourSteps: [],
    };
  }
  if ("tourStep" in update) {
    return state.tourSteps.includes(update.tourStep)
      ? state
      : { ...state, tourSteps: [...state.tourSteps, update.tourStep] };
  }
  if ("completed" in update) {
    return { ...state, completedAt: new Date().toISOString(), skipped: update.skipped, version: ONBOARDING_VERSION };
  }
  return state;
}
