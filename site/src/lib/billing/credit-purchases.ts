import type Stripe from "stripe";

import { creditStringToMicros } from "@/lib/credits/amounts";
import { creditAutoReloadKind, creditTopUpKind } from "@/lib/credits/top-up";
import { grantCredits } from "@/lib/credits/inference";

function parseAmountDollars(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// The ledger source each purchase kind granted under, so a redelivered event
// dedupes against the grant it already made.
const PURCHASE_SOURCES = new Map<string, { source: string; label: string }>([
  [creditTopUpKind, { source: "stripe_topup", label: "credit top-up" }],
  [creditAutoReloadKind, { source: "stripe_autoreload", label: "auto-reload" }],
]);

// Credit purchases are retired, but a top-up or auto-reload charged before
// the change can still settle. Its PaymentIntent lands the credits it paid
// for. Idempotent on (source, sourceId): grantCredits dedupes by the
// PaymentIntent id, so a repeated delivery grants once.
//
// Purchased credits never expire: no expiresAt / periodEnd is set, which also
// places them last in the debit queue (see compareGrantConsumptionOrder in
// credits/inference.ts).
export async function handleCreditPaymentSucceeded(
  paymentIntent: Stripe.PaymentIntent,
): Promise<void> {
  const purchase = PURCHASE_SOURCES.get(paymentIntent.metadata?.kind ?? "");
  if (!purchase) {
    return;
  }
  const userId = paymentIntent.metadata?.userId;
  const amountDollars = parseAmountDollars(paymentIntent.metadata?.amountDollars);
  if (!userId || !amountDollars) {
    console.error("[billing] incomplete credit purchase payment", {
      amountDollars,
      paymentIntent: paymentIntent.id,
      userId,
    });
    return;
  }

  await grantCredits({
    amountMicros: creditStringToMicros(String(amountDollars)),
    description: `$${amountDollars} ${purchase.label}`,
    metadata: {
      amountDollars: String(amountDollars),
      purchaseSource: purchase.source,
    },
    source: purchase.source,
    sourceId: paymentIntent.id,
    userId,
  });
}
