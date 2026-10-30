import type Stripe from "stripe";

import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";
import { DEFAULT_CURRENCY, fromMinor, isCurrency } from "@/lib/billing/currencies";
import type { PLAN_NAMES } from "@/lib/billing/plans";
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

// A checkout converts once it is paid. One that needs no payment ran under a
// full discount, which is how we test plans, so it is no purchase. An async
// method settles later, through checkout.session.async_payment_succeeded.
const CONVERTED: ReadonlySet<Stripe.Checkout.Session["payment_status"]> = new Set(["paid"]);

// The plan a checkout sells, by its display name.
export type CheckoutProduct = (typeof PLAN_NAMES)[keyof typeof PLAN_NAMES];

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
    value: purchaseValue(session),
  });
}

// What a checkout charged, in its own currency. Stripe states amounts in the
// currency's minor unit, which for yen and won is the whole unit; a currency
// Stripe presented on its own, outside the ones the plans sell in, reads its
// ISO digits.
function purchaseValue(session: Stripe.Checkout.Session): { amount: number; currency: string } {
  const currency = session.currency ?? DEFAULT_CURRENCY;
  const minor = session.amount_total ?? 0;
  if (isCurrency(currency)) {
    return { amount: fromMinor(minor, currency), currency };
  }
  const digits = new Intl.NumberFormat("en", { currency, style: "currency" }).resolvedOptions().maximumFractionDigits ?? 2;
  return { amount: minor / 10 ** digits, currency };
}
