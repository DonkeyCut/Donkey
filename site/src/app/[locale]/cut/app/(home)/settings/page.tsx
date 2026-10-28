"use client";

import { useEffect } from "react";

import { CreditsCard } from "@/app/[locale]/cut/app/(home)/settings/_components/CreditsCard";
import { ProCard } from "@/app/[locale]/cut/app/(home)/settings/_components/ProCard";
import { SettingsGuard } from "@/cut/components/SettingsGuard";
import { track } from "@/lib/analytics";

// The query Stripe's checkout, and an in-place upgrade, come back with.
const CHECKOUT_PARAM = "checkout";
const CHECKOUT_RESULTS = ["success", "cancelled"] as const;

// Cut's billing page: the subscription that carries the monthly AI credits,
// plus the credit balance.
export default function CutBillingPage() {
  useCheckoutReturn();
  return (
    <SettingsGuard>
      <div className="max-w-2xl space-y-6 pb-9">
        <ProCard />
        <CreditsCard />
      </div>
    </SettingsGuard>
  );
}

// Reports the trip back from checkout once, then drops the query so a reload
// does not count it again.
function useCheckoutReturn() {
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = CHECKOUT_RESULTS.find((r) => r === url.searchParams.get(CHECKOUT_PARAM));
    if (!result) {
      return;
    }
    track("checkout_returned", { result });
    url.searchParams.delete(CHECKOUT_PARAM);
    window.history.replaceState(null, "", url);
  }, []);
}
