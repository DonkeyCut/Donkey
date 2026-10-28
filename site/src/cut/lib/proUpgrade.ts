"use client";

// One way into plan checkout, shared by every surface that sells a plan. A
// free account leaves for Stripe; an account already on a plan moves up in
// place and lands back on settings.
import { useState } from "react";

import type { PaidPlan } from "@/lib/billing/plans";
import { track } from "@/lib/analytics";
import { useStartCheckout } from "@/queries/billing";

export function usePlanCheckout() {
  const checkout = useStartCheckout();
  const [pendingPlan, setPendingPlan] = useState<PaidPlan | null>(null);

  const start = (plan: PaidPlan) => {
    track("pro_checkout_started", { plan });
    setPendingPlan(plan);
    checkout.mutate(
      { plan },
      {
        onSuccess: ({ url }) => window.location.assign(url),
        onError: () => setPendingPlan(null),
      },
    );
  };

  return { start, pendingPlan, error: checkout.error };
}
