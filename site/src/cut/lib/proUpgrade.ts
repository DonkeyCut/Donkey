"use client";

// One way into plan checkout, shared by every surface that sells a plan. A
// free account leaves for Stripe; an account already on a plan moves up in
// place and lands back on settings.
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { PaidPlan } from "@/lib/billing/plans";
import { track, type CheckoutOrigin } from "@/lib/analytics";
import { ApiError } from "@/queries/apiClient";
import { proSubscriptionQueryKey, useStartCheckout } from "@/queries/billing";

/** A checkout's failure as analytics names it: the API's error code, the
 * HTTP status when the route sent none, or "network". */
export function checkoutErrorCode(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return "network";
  }
  return error.code ?? `http_${error.status}`;
}

export function usePlanCheckout(origin: CheckoutOrigin) {
  const checkout = useStartCheckout();
  const queryClient = useQueryClient();
  const [pendingPlan, setPendingPlan] = useState<PaidPlan | null>(null);

  const start = (plan: PaidPlan) => {
    track("pro_checkout_started", { plan, ...origin });
    setPendingPlan(plan);
    checkout.mutate(
      { plan },
      {
        onSuccess: ({ url }) => window.location.assign(url),
        onError: (error) => {
          setPendingPlan(null);
          // A refusal can mean the account already holds the plan, synced by
          // the route just now, so the surface rereads it.
          void queryClient.invalidateQueries({ queryKey: proSubscriptionQueryKey });
          track("pro_checkout_failed", { plan, error: checkoutErrorCode(error), ...origin });
        },
      },
    );
  };

  return { start, pendingPlan, error: checkout.error };
}
