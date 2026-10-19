"use client";

import { useMutation, useQuery } from "@tanstack/react-query";

import { apiFetch } from "@/queries/apiClient";

export const usageQueryKey = ["billing", "usage"] as const;
export const proSubscriptionQueryKey = ["billing", "pro"] as const;
export const introOfferQueryKey = ["billing", "intro-offer"] as const;

export type ProSubscription = {
  isActive: boolean;
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

export function useProSubscription() {
  return useQuery({
    queryFn: fetchProSubscription,
    queryKey: proSubscriptionQueryKey,
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
// applies it on its own; this read is for the surfaces that show it.
export function useIntroOffer({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    enabled,
    queryFn: async () => (await apiFetch<{ offer: IntroOffer | null }>("/api/billing/intro-offer")).offer,
    queryKey: introOfferQueryKey,
    staleTime: 5 * 60_000,
  });
}

export type UsageHistory = {
  // Recent credit-billed inference calls, newest first.
  recent: {
    createdAt: string;
    // The app conversation this call belongs to; null for background/warm calls
    // and rows recorded before grouping existed. Drives the grouped rendering.
    conversationId: string | null;
    requestKind: string;
    model: string;
    status: string;
    // USD cost charged to credits.
    costCredits: string;
    billingStatus: string;
    errorCode: string | null;
    // Token breakdown that explains the cost.
    usage: {
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      totalTokens: number;
      // Images produced by asset_generation calls (priced per image).
      generationCount: number;
      durationMillis: number;
    };
  }[];
};

export function useUsage() {
  return useQuery({
    queryFn: () => apiFetch<UsageHistory>("/api/billing/usage"),
    queryKey: usageQueryKey,
  });
}

// Mutations return the Stripe URL; the caller redirects the browser. We don't
// invalidate here because the user leaves the page for Stripe.
// A checkout opened from an offer's claim link passes the offer's token, so
// the credit that lands is the one the dialog described.
export function useStartCheckout() {
  return useMutation({
    mutationFn: (input?: { offerToken: string } | void) =>
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
