import type Stripe from "stripe";

import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";
import type { PlanTerms } from "@/lib/billing/plans";
import { metaBrowser, type MetaBrowser, trackMetaEvent } from "@/lib/meta/conversions";

// A purchase completes in Stripe's webhook, far from the browser that paid.
// The checkout session carries that browser's ids, address, and user agent in
// its metadata, and the webhook reports the purchase with them.

// Stripe caps a metadata value at 500 characters.
const STRIPE_METADATA_MAX = 500;

const METADATA_KEYS = {
  fbc: "metaFbc",
  fbp: "metaFbp",
  ip: "metaIp",
  userAgent: "metaUserAgent",
} as const satisfies Record<keyof MetaBrowser, string>;

// Checkouts open from the editor and its settings; Meta needs a page on the site.
const CHECKOUT_PAGE = `${DONKEYCUT_CANONICAL}/app/settings`;

// Stripe amounts are in the currency's minor unit; Donkey charges in dollars.
const CENTS_PER_DOLLAR = 100;

// A checkout converts once it is paid, or needs no payment at all (a Pro
// checkout under a full discount). An async method settles later, through
// checkout.session.async_payment_succeeded.
const CONVERTED: ReadonlySet<Stripe.Checkout.Session["payment_status"]> = new Set(["paid", "no_payment_required"]);

// The plan a checkout sells, by its display name.
export type CheckoutProduct = PlanTerms["name"];

/** The browser behind a checkout request, as checkout session metadata. */
export function metaCheckoutMetadata(headers: Headers): Record<string, string> {
  const browser = metaBrowser(headers);
  const metadata: Record<string, string> = {};
  for (const [field, key] of Object.entries(METADATA_KEYS)) {
    const value = browser[field as keyof MetaBrowser];
    if (value) {
      metadata[key] = value.slice(0, STRIPE_METADATA_MAX);
    }
  }
  return metadata;
}

/** Reports a checkout the account just opened. */
export function trackCheckoutStarted(
  checkoutId: string,
  product: CheckoutProduct,
  headers: Headers,
  user: { id: string; email: string },
): void {
  trackMetaEvent({
    browser: metaBrowser(headers),
    content: product,
    id: `checkout-start-${checkoutId}`,
    name: "InitiateCheckout",
    url: CHECKOUT_PAGE,
    user,
  });
}

/** Reports a paid checkout as a purchase, with the browser it opened in. */
export function trackCheckoutPurchase(session: Stripe.Checkout.Session): void {
  if (!CONVERTED.has(session.payment_status) || !session.client_reference_id) {
    return;
  }

  const metadata = session.metadata ?? {};
  trackMetaEvent({
    browser: {
      fbc: metadata[METADATA_KEYS.fbc],
      fbp: metadata[METADATA_KEYS.fbp],
      ip: metadata[METADATA_KEYS.ip],
      userAgent: metadata[METADATA_KEYS.userAgent],
    },
    // The plan the checkout named; a credit purchase begun before they were
    // retired settles as "Credits".
    content: session.metadata?.plan ?? (session.mode === "subscription" ? "Pro" : "Credits"),
    id: `checkout-${session.id}`,
    name: "Purchase",
    url: CHECKOUT_PAGE,
    user: { email: session.customer_details?.email, id: session.client_reference_id },
    value: { amount: (session.amount_total ?? 0) / CENTS_PER_DOLLAR, currency: session.currency ?? "usd" },
  });
}
