"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/queries/apiClient";

export const creditBalanceQueryKey = ["credits", "balance"] as const;
export const creditAutoReloadQueryKey = ["credits", "auto-reload"] as const;
export const accountQueryKey = ["account", "me"] as const;
export const subscribeBonusQueryKey = ["credits", "subscribe-bonus"] as const;

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

export type SubscribeBonus = {
  // Where the offer reached the person: the app opened the bonus on its own,
  // a promotion came by email.
  origin: "app" | "email";
  // USD, as a credit string.
  dollars: string;
  openedAt: string;
  closesAt: string;
  // The credit's life once it lands: a fixed last moment, or days from the
  // claim. Both null keeps it forever.
  creditsExpireAt: string | null;
  creditsLifetimeDays: number | null;
  status: "open" | "closed" | "claimed";
};

// The account's subscribe bonus offer. The read is what opens it, so the
// query keeps asking while the app is up: a poll between charges, and a
// refetch when the tab comes back.
export function useSubscribeBonus(options: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: options.enabled ?? true,
    queryFn: () => apiFetch<{ offer: SubscribeBonus | null }>("/api/credits/subscribe-bonus"),
    queryKey: subscribeBonusQueryKey,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    select: (data) => data.offer,
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
        offer: { closesAt: string | null; expiresAfterDays: number | null; id: string };
        targetUser: { email: string };
      }>(
        "/api/credits/offers",
        { body: JSON.stringify(input), method: "POST" },
      ),
  });
}

export const creditOfferQueryKey = (token: string) => ["credits", "offer", token] as const;

export type CreditOffer = {
  // What lands the credit: the Claim button, or a Pro subscription started
  // inside the window.
  claim: "link" | "subscribe";
  claimed: boolean;
  // The last moment the offer can be claimed; null keeps it open.
  closesAt: string | null;
  // Formatted USD, "$5".
  credits: string;
  // When the claimed credit expires; null before the claim and for a credit
  // that keeps forever.
  expiresAt: string | null;
  // How many days the claimed credit lasts; null when it keeps forever.
  lifetimeDays: number | null;
};

// The offer a claim link names. 404 is a link that no longer opens anything;
// 403 is an offer made to another account; 410 is a claim window that closed;
// 409 is a subscribe offer read by an account that already holds Pro.
export function useCreditOffer(token: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: options.enabled ?? true,
    queryFn: () => apiFetch<CreditOffer>(`/api/credits/offers/claim?token=${encodeURIComponent(token)}`),
    queryKey: creditOfferQueryKey(token),
    retry: false,
  });
}

// Lands the offer on the signed-in account. The balance re-reads so the top
// bar shows the credit at once, and the offer's own entry records the claim,
// so a dialog that opens on the same token again presents the landed credit.
export function useClaimCreditOffer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) =>
      apiFetch<{ balance: string; credits: string; expiresAt: string | null }>(
        "/api/credits/offers/claim",
        { body: JSON.stringify({ token }), method: "POST" },
      ),
    onSuccess: (landed, token) => {
      queryClient.setQueryData<CreditOffer>(creditOfferQueryKey(token), (offer) =>
        offer ? { ...offer, claimed: true, expiresAt: landed.expiresAt } : offer,
      );
      void queryClient.invalidateQueries({ queryKey: creditBalanceQueryKey });
    },
  });
}
