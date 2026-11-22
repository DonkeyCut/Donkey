"use client";

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { DEFAULT_CURRENCY, type Currency } from "@/lib/billing/currencies";
import type { PaidPlan } from "@/lib/billing/plans";
import { apiFetch } from "@/queries/apiClient";

export const proSubscriptionQueryKey = ["billing", "pro"] as const;

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

// What the account pays in, read as the app starts.
type PricingRead = { currency: Currency };

const pricingQueryKey = ["billing", "pricing"] as const;
const PRICING_URL = "/api/billing/pricing";
const PRICING_STALE_MS = 5 * 60_000;

const fetchPricing = () => apiFetch<PricingRead>(PRICING_URL);

/** Load the account's pricing as the app starts, ahead of every surface
 * that sells a plan, so each paints in its currency on its first frame. */
export function prefetchPricing(client: QueryClient): Promise<void> {
  return client.prefetchQuery({ queryFn: fetchPricing, queryKey: pricingQueryKey, staleTime: PRICING_STALE_MS });
}

function usePricing({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ enabled, queryFn: fetchPricing, queryKey: pricingQueryKey, staleTime: PRICING_STALE_MS });
}

/** The currency the account's plans price and check out in. */
export function useAccountCurrency({ enabled }: { enabled: boolean }): { currency: Currency; isPending: boolean } {
  const read = usePricing({ enabled });
  return { currency: read.data?.currency ?? DEFAULT_CURRENCY, isPending: read.isPending };
}

// Mutations return the Stripe URL; the caller redirects the browser. We don't
// invalidate here because the user leaves the page for Stripe.
// A checkout names its plan (Pro when unnamed). One opened from an offer's
// claim link passes the offer's token, so the credit that lands is the one the
// dialog described. An account already on a plan moves up in place and comes
// back with the settings URL.
// Every checkout names the currency the account's pricing read gave its
// surface. The route refuses one the account no longer checks out in, so a
// charge never differs from the card; a checkout sent before that read
// landed showed no price and names none.
export function useStartCheckout() {
  const queryClient = useQueryClient();
  const currency = usePricing().data?.currency;
  return useMutation({
    mutationFn: (input?: { plan?: PaidPlan; offerToken?: string } | void) =>
      apiFetch<{ url: string }>("/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ ...input, currency }),
      }),
    onError: () => queryClient.invalidateQueries({ queryKey: pricingQueryKey }),
  });
}

export function useOpenBillingPortal() {
  return useMutation({
    mutationFn: () =>
      apiFetch<{ url: string }>("/api/billing/portal", { method: "POST" }),
  });
}
