"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/queries/apiClient";

export const creditBalanceQueryKey = ["credits", "balance"] as const;
export const creditAutoReloadQueryKey = ["credits", "auto-reload"] as const;
export const accountQueryKey = ["account", "me"] as const;

export type CreditBalance = {
  balance: string;
  balanceMicros: string;
  lifetimeCharged: string;
  lifetimeGranted: string;
  recentUsageTotals: {
    count: number;
    creditsCharged: string;
    failedCount: number;
    model: string;
    provider: string;
    route: string;
  }[];
};

export type CreditAutoReload = {
  enabled: boolean;
  thresholdDollars: number;
  amountDollars: number;
  hasPaymentMethod: boolean;
  status: string;
  lastError: string | null;
};

export type Account = {
  userId: string;
  email: string | null;
  superUser: boolean;
};

export function useCreditBalance() {
  return useQuery({
    queryFn: () => apiFetch<CreditBalance>("/api/credits/balance"),
    queryKey: creditBalanceQueryKey,
  });
}

export function useAccount() {
  return useQuery({
    queryFn: () => apiFetch<Account>("/api/account/me"),
    queryKey: accountQueryKey,
  });
}

// Returns the Stripe Checkout URL; the caller redirects the browser. No
// invalidation here because the user leaves the page for Stripe and returns to
// /app/settings, which refetches on mount.
export function useStartCreditCheckout() {
  return useMutation({
    mutationFn: (amountDollars: number) =>
      apiFetch<{ url: string }>("/api/billing/credits/checkout", {
        body: JSON.stringify({ amountDollars }),
        method: "POST",
      }),
  });
}

export function useCreditAutoReload() {
  return useQuery({
    queryFn: () => apiFetch<CreditAutoReload>("/api/billing/credits/auto-reload"),
    queryKey: creditAutoReloadQueryKey,
  });
}

export function useUpdateCreditAutoReload() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      enabled: boolean;
      thresholdDollars: number;
      amountDollars: number;
    }) =>
      apiFetch<CreditAutoReload>("/api/billing/credits/auto-reload", {
        body: JSON.stringify(input),
        method: "PUT",
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: creditAutoReloadQueryKey }),
  });
}

// Super-user only: offer credits to a user (by email) or to self (by userId).
// The credit lands when the person claims it from the email.
export function useOfferCredits() {
  return useMutation({
    mutationFn: (input: {
      amountDollars: number;
      email?: string;
      // Days the credit lives once claimed; null keeps it forever.
      expiresAfterDays: number | null;
      userId?: string;
    }) =>
      apiFetch<{
        offer: { expiresAfterDays: number | null; id: string };
        targetUser: { email: string };
      }>(
        "/api/credits/offers",
        { body: JSON.stringify(input), method: "POST" },
      ),
  });
}
