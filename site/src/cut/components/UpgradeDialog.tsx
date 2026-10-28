"use client";

// The wall an account meets at a paid limit — a request that ran out of
// credits, one project past the free count — or the plans it asks to see.
// Each opens the plan ladder with words for why it is up.
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { PlansDialog } from "@/cut/components/PlansDialog";
import { onOperationFailure } from "@/cut/lib/operationFailure";
import { onUpgrade, openUpgrade, type UpgradeReason } from "@/cut/lib/upgrade";
import { PAID_PLANS, PLAN_TERMS } from "@/lib/billing/plans";
import { useProSubscription } from "@/queries/billing";

export function UpgradeDialog() {
  const [reason, setReason] = useState<UpgradeReason | null>(null);

  useEffect(() => onUpgrade(setReason), []);

  // A request refused for credits always raises the plans.
  useEffect(
    () =>
      onOperationFailure((failure) => {
        if (failure.code === "insufficient_credits" || failure.code === "insufficient_credits_for_generation") {
          openUpgrade("credits");
        }
      }),
    [],
  );

  if (!reason) {
    return null;
  }
  return <OpenDialog reason={reason} onClose={() => setReason(null)} />;
}

// Split so the billing read only runs while the dialog is up.
function OpenDialog({ reason, onClose }: { reason: UpgradeReason; onClose: () => void }) {
  const t = useTranslations("billing");
  const format = useFormatter();
  const subscription = useProSubscription();
  const plan = subscription.data?.plan ?? null;
  const periodEnd = subscription.data?.currentPeriodEnd ?? null;

  // Out of credits: a free account is asked to pick a plan; a paying one is
  // told a bigger plan lands credits today, and when its own refill comes.
  const outOfCredits = () => {
    if (!plan || !periodEnd) {
      return { title: t("plans.freeOutTitle") };
    }
    const words = { plan: PLAN_TERMS[plan].name, date: format.dateTime(new Date(periodEnd), { day: "numeric", month: "long" }) };
    return plan === PAID_PLANS[PAID_PLANS.length - 1]
      ? { title: t("plans.topOutTitle", words) }
      : { title: t("plans.paidOutTitle"), body: t("plans.paidOutBody", words) };
  };

  const wall: { title: string; body?: string } =
    reason === "credits"
      ? outOfCredits()
      : reason === "projects"
        ? { title: t("upgrade.projectsTitle"), body: t("upgrade.projectsBody") }
        : { title: t("plans.chooseTitle"), body: t("plans.chooseBody") };

  return <PlansDialog source={reason} {...wall} onClose={onClose} />;
}
