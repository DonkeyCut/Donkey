"use client";

import { useMutation, useQuery } from "@tanstack/react-query";

import type { PaidPlan } from "@/lib/billing/plans";
import { apiFetch } from "@/queries/apiClient";

export const proSubscriptionQueryKey = ["billing", "pro"] as const;
export const introOfferQueryKey = ["billing", "intro-offer"] as const;

export type ProSubscription = {
  isActive: boolean;
  // The running plan; null on a free account.
  plan: PaidPlan | null;
  status: string | null;
  // End of the current billing period: the allowance resets and the plan
  // renews here.
  currentPeriodEnd: string | null;
  // When a scheduled cancel ends Pro; null while the plan renews.
  endsAt: string | null;
  // Included monthly allowance (USD) and how much is left this period.
  monthlyAllowance: string | null;
  allowanceRemaining: string;
};

export const fetchProSubscription = () => apiFetch<ProSubscription>("/api/billing/pro");

// A surface waiting on a plan to land, such as the phone paywall after a
// checkout, rereads it every pollMs.
export function useProSubscription({ pollMs }: { pollMs?: number } = {}) {
  return useQuery({
    queryFn: fetchProSubscription,
    queryKey: proSubscriptionQueryKey,
    refetchInterval: (query) => (pollMs && !query.state.data?.isActive ? pollMs : false),
  });
}

export type IntroOffer = {
  percentOff: number;
  months: number;
  // When the offer closes.
  endsAt: string;
  // The Pro price and what the discounted months cost.
  priceCents: number;
  introCents: number;
};

// The discount an account inside its intro window gets on Pro. Checkout
// applies it on its own; this read is for the surfaces that show it, and the
// first one starts the window.
export function useIntroOffer({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    enabled,
    queryFn: async () =>
      (await apiFetch<{ offer: IntroOffer | null }>("/api/billing/intro-offer", { method: "POST" })).offer,
    queryKey: introOfferQueryKey,
    staleTime: 5 * 60_000,
  });
}

// Mutations return the Stripe URL; the caller redirects the browser. We don't
// invalidate here because the user leaves the page for Stripe.
// A checkout names its plan (Pro when unnamed). One opened from an offer's
// claim link passes the offer's token, so the credit that lands is the one the
// dialog described. An account already on a plan moves up in place and comes
// back with the settings URL.
export function useStartCheckout() {
  return useMutation({
    mutationFn: (input?: { plan?: PaidPlan; offerToken?: string } | void) =>
      apiFetch<{ url: string }>("/api/billing/checkout", {
        method: "POST",
        ...(input ? { body: JSON.stringify(input) } : {}),
      }),
  });
}

export function useOpenBillingPortal() {
  return useMutation({
    mutationFn: () =>
      apiFetch<{ url: string }>("/api/billing/portal", { method: "POST" }),
  });
}
