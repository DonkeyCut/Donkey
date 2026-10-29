"use client";

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

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

export type IntroOffer = {
  percentOff: number;
  months: number;
  // When the offer closes.
  endsAt: string;
  // The Pro price and what the discounted months cost, in the currency's
  // minor unit.
  currency: Currency;
  priceMinor: number;
  introMinor: number;
};

// The offer as the app loads it: endsAt is null while the window has not
// started, and it runs windowHours from the moment a surface first shows it.
type IntroOfferRead = Omit<IntroOffer, "endsAt"> & { endsAt: string | null; windowHours: number };

// What the account pays in and the intro offer open to it, read together as
// the app starts.
type PricingRead = { currency: Currency; intro: IntroOfferRead | null };

const pricingQueryKey = ["billing", "pricing"] as const;
const PRICING_URL = "/api/billing/pricing";
const INTRO_OFFER_URL = "/api/billing/intro-offer";
const PRICING_STALE_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;

const fetchPricing = () => apiFetch<PricingRead>(PRICING_URL);

/** Load the account's pricing as the app starts, ahead of every surface
 * that sells a plan, so each paints in its currency and with the offer on
 * its first frame. Reading starts nothing. */
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

// The discount an account inside its intro window gets on Pro. Checkout
// applies it on its own; this read is for the surfaces that show it, and the
// first one to show it starts the window. A surface that shows no offer, such
// as one for an account already on a plan, passes enabled: false.
export function useIntroOffer({ enabled = true }: { enabled?: boolean } = {}): {
  data: IntroOffer | null | undefined;
  isPending: boolean;
} {
  const queryClient = useQueryClient();
  const read = usePricing();
  const offer = enabled ? read.data?.intro : undefined;

  // A window this surface is the first to show runs from its mount, the
  // moment the start below lands on the server too; the countdown keeps that
  // anchor, so it never jumps when the server's answer arrives.
  const [mountedAt] = useState(() => Date.now());
  const [startedHere, setStartedHere] = useState(false);
  const unstarted = offer !== undefined && offer !== null && offer.endsAt === null;
  if (unstarted && !startedHere) {
    setStartedHere(true);
  }
  useEffect(() => {
    if (!unstarted) {
      return;
    }
    void apiFetch<{ endsAt: string | null }>(INTRO_OFFER_URL, { method: "POST" }).then(({ endsAt }) => {
      queryClient.setQueryData<PricingRead>(pricingQueryKey, (prev) =>
        prev?.intro ? { ...prev, intro: endsAt ? { ...prev.intro, endsAt } : null } : prev,
      );
    });
  }, [unstarted, queryClient]);

  if (!enabled) {
    return { data: undefined, isPending: true };
  }
  if (!offer) {
    return { data: offer, isPending: read.isPending };
  }
  const endsAt =
    startedHere || offer.endsAt === null
      ? new Date(mountedAt + offer.windowHours * HOUR_MS).toISOString()
      : offer.endsAt;
  return { data: { ...offer, endsAt }, isPending: read.isPending };
}

// Mutations return the Stripe URL; the caller redirects the browser. We don't
// invalidate here because the user leaves the page for Stripe.
// A checkout names its plan (Pro when unnamed). One opened from an offer's
// claim link passes the offer's token, so the credit that lands is the one the
// dialog described. An account already on a plan moves up in place and comes
// back with the settings URL.
// Every checkout names the currency its surface showed. The route refuses
// one the account no longer checks out in, so a charge never differs from
// the card.
export function useStartCheckout() {
  const queryClient = useQueryClient();
  const { currency } = useAccountCurrency({ enabled: true });
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
