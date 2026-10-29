"use client";

// The starter tour's hold on new projects. While an account owes the tour, the
// onboarding host in the app shell registers here, and every way of making a
// project asks first: newProjectAllowed for the home, the sidebar, a file drop
// and a duplicate. The shared view runs outside the app shell, so its copy
// reads the account's stage itself. A held ask sends the account back to the
// tour. The ChatGPT card mounts no host, so nothing holds there.

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";

import { useEngineUser } from "@/cut/lib/backend/hooks";
import { useEnvironment } from "@/cut/lib/environment";
import { projectHref, useCutBase } from "@/cut/lib/nav";
import { starterProjectId } from "@/cut/lib/starter";
import { track } from "@/lib/analytics";
import { onboardingStage } from "@/lib/onboarding/stage";
import { fetchOnboardingState, onboardingQueryKey, useOnboardingState } from "@/queries/onboarding";

let resumeTour: (() => void) | null = null;

/** Registers the host's way back to the tour; returns the release. */
export function holdNewProjects(resume: () => void): () => void {
  resumeTour = resume;
  return () => {
    if (resumeTour === resume) {
      resumeTour = null;
    }
  };
}

/** True when the tour holds new projects. The account is already on its way
 * back to the tour. */
export function tourHoldsProjects(): boolean {
  if (!resumeTour) {
    return false;
  }
  resumeTour();
  return true;
}

/** The shared view's copy: true when the tour holds new projects, with the
 * account already on its way to its starter. Read fresh, since the view has
 * no app shell keeping the account's stage. */
export async function tourHoldsCopy(userId: string, base: string): Promise<boolean> {
  if (onboardingStage(await fetchOnboardingState()) !== "tour") {
    return false;
  }
  track("onboarding_tour_resumed");
  window.location.href = projectHref(base, starterProjectId(userId), "projects");
  return true;
}

/** Whether the tour holds new projects for this account, and the way back to
 * it: the starter project, where the tour picks up at its next step. */
export function useTourLock(): { locked: boolean; resume: () => void } {
  const { chatgpt } = useEnvironment();
  const { data } = useOnboardingState();
  const userId = useEngineUser();
  const router = useRouter();
  const base = useCutBase();
  const locked = !chatgpt && onboardingStage(data) === "tour";

  const resume = useCallback(() => {
    if (!userId) {
      return;
    }
    track("onboarding_tour_resumed");
    router.push(projectHref(base, starterProjectId(userId), "projects"));
  }, [base, router, userId]);

  return { locked, resume };
}

/** Whether the tour keeps the account in this project: the starter, until
 * the tour is done. */
export function useTourHoldsStarter(projectId: string | null): boolean {
  const { locked } = useTourLock();
  const userId = useEngineUser();
  return locked && userId !== null && projectId === starterProjectId(userId);
}

/** Rereads the account's onboarding once a removed project was its starter.
 * The account row then says the starter is gone, the tour hands over to the
 * plans, and nothing sends the account to a project that no longer exists. */
export function useStarterGone(): (projectId: string) => void {
  const queryClient = useQueryClient();
  const userId = useEngineUser();
  return useCallback(
    (projectId: string) => {
      if (!userId || projectId !== starterProjectId(userId)) {
        return;
      }
      void queryClient.invalidateQueries({ queryKey: onboardingQueryKey });
    },
    [queryClient, userId],
  );
}
