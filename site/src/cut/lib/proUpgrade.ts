"use client";

// One way into Pro checkout, shared by every surface that sells storage.
import { useCutBase } from "@/cut/lib/nav";
import { track } from "@/lib/analytics";
import { useStartCheckout } from "@/queries/billing";

export function useUpgradeToPro() {
  const checkout = useStartCheckout();
  const base = useCutBase();

  const start = () => {
    track("pro_checkout_started");
    void (async () => {
      try {
        const { url } = await checkout.mutateAsync();
        window.location.assign(url);
      } catch {
        // Checkout can't start (an unconfigured plan 404s); the billing page
        // carries the same subscribe action, so send them there rather than
        // leaving the button dead.
        window.location.assign(`${base}/settings`);
      }
    })();
  };

  return { start, isPending: checkout.isPending };
}
