"use client";

import { useMutation, useQuery } from "@tanstack/react-query";

import { apiFetch } from "@/queries/apiClient";

export const usageQueryKey = ["billing", "usage"] as const;
export const proSubscriptionQueryKey = ["billing", "pro"] as const;

export type ProSubscription = {
  isActive: boolean;
  status: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  // Included monthly allowance (USD) and how much is left this period.
  monthlyAllowance: string | null;
  allowanceRemaining: string;
};

export function useProSubscription() {
  return useQuery({
    queryFn: () => apiFetch<ProSubscription>("/api/billing/pro"),
    queryKey: proSubscriptionQueryKey,
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
export function useStartCheckout() {
  return useMutation({
    mutationFn: () =>
      apiFetch<{ url: string }>("/api/billing/checkout", { method: "POST" }),
  });
}

export function useOpenBillingPortal() {
  return useMutation({
    mutationFn: () =>
      apiFetch<{ url: string }>("/api/billing/portal", { method: "POST" }),
  });
}
