"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ONBOARDING_VERSION, type ReferralSource } from "@/lib/onboarding/sequence";
import { apiFetch } from "@/queries/apiClient";

export const onboardingQueryKey = ["account-onboarding"] as const;

export type OnboardingState = {
  version: number;
  completedAt: string | null;
  skipped: boolean;
  referralSource: string | null;
};

type OnboardingUpdate =
  | { referralSource: ReferralSource; referralDetail?: string }
  | { completed: true; skipped: boolean };

/** Whether this account still owes us a run of the current sequence. */
export function needsOnboarding(state: OnboardingState | undefined): boolean {
  if (!state) return false;
  return state.completedAt === null || state.version < ONBOARDING_VERSION;
}

export function useOnboardingState() {
  return useQuery({
    queryFn: () => apiFetch<OnboardingState>("/api/account/onboarding"),
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
    mutationFn: (update: OnboardingUpdate) =>
      apiFetch<OnboardingState>("/api/account/onboarding", {
        body: JSON.stringify(update),
        method: "PUT",
      }),
    onSuccess: (state) => {
      queryClient.setQueryData(onboardingQueryKey, state);
    },
  });
}
