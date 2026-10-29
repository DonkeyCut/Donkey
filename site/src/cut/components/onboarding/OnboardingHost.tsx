"use client";

// The app shell's part in onboarding after the slides. While the starter tour
// is owed it holds new projects (src/cut/lib/tourLock.ts). Once the tour is
// done, or when an account has no starter to tour, it shows the plans, and
// showing them is what ends onboarding: closing the dialog and leaving for
// checkout both find the account already done. A subscriber sees the plan they
// hold marked as current. Mounted behind the phone gate and outside the
// ChatGPT card, which has no onboarding.

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { PlansDialog } from "@/cut/components/PlansDialog";
import { useEnvironment } from "@/cut/lib/environment";
import { useOnboardingCover, useTourSignals } from "@/cut/lib/onboarding";
import { holdNewProjects, useTourLock } from "@/cut/lib/tourLock";
import { track } from "@/lib/analytics";
import { TOUR_STEPS } from "@/lib/onboarding/sequence";
import { onboardingStage } from "@/lib/onboarding/stage";
import { useProSubscription } from "@/queries/billing";
import { useOnboardingState, useSaveOnboarding } from "@/queries/onboarding";

export function OnboardingHost() {
  const t = useTranslations("onboarding.plans");
  const { chatgpt } = useEnvironment();
  const { data: state } = useOnboardingState();
  const { mutate: saveOnboarding } = useSaveOnboarding();
  const covered = useOnboardingCover((s) => s.up);
  const held = useTourSignals((s) => s.hold !== null);
  const subscription = useProSubscription();
  const lock = useTourLock();

  // New projects wait on the tour.
  useEffect(() => (lock.locked ? holdNewProjects(lock.resume) : undefined), [lock.locked, lock.resume]);

  // The plans are owed once the slides are down, the tour's last pause is
  // over, the stage says so, and the plan is known. A billing read that fails still shows the dialog, which
  // says the failure itself.
  const owed =
    !chatgpt &&
    !covered &&
    !held &&
    onboardingStage(state) === "plans" &&
    (subscription.isSuccess || subscription.isError);
  // Latched per run, keyed by when its slides ended, so a replay shows the
  // plans again. The dialog stays latched open through the stage flipping to
  // done.
  const runKey = state?.slidesDoneAt ?? null;
  const [shownFor, setShownFor] = useState<string | null>(null);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  if (owed && runKey !== null && shownFor !== runKey) {
    setShownFor(runKey);
  }
  const shown = runKey !== null && shownFor === runKey;
  const dismissed = runKey !== null && dismissedFor === runKey;

  // Ends onboarding the moment the plans are owed.
  const subscriber = subscription.data?.isActive ?? false;
  useEffect(() => {
    if (!shown) {
      return;
    }
    track("onboarding_completed", { source: "first_run", skipped: false, step: TOUR_STEPS.length });
    saveOnboarding({ completed: true, skipped: false });
  }, [shown, saveOnboarding]);

  if (!shown || dismissed) {
    return null;
  }
  return (
    <PlansDialog
      source="onboarding"
      entry="onboarding_tour"
      title={t("title")}
      body={t("subtitle")}
      dismissLabel={subscriber ? t("continue") : t("continueFree")}
      onClose={() => setDismissedFor(runKey)}
    />
  );
}
