import { NextResponse } from "next/server";
import { z } from "zod";

import { requestLocale } from "@/i18n/requestLocale";
import { translatorFor } from "@/i18n/translator";
import { auth } from "@/lib/auth";
import { metaCheckoutMetadata, trackCheckoutStarted } from "@/lib/billing/meta-checkout";
import { ensureStripeCustomer, getStripe } from "@/lib/billing/stripe";
import { STRIPE_LOCALE } from "@/lib/billing/stripe-locale";
import { creditCountLabel, creditsPerDollar } from "@/lib/credits/format-credits";
import {
  creditTopUpKind,
  creditTopUpMaxDollars,
  creditTopUpMinDollars,
  dollarsToStripeCents,
} from "@/lib/credits/top-up";
import { unauthorizedResponse, withDonkeyAuth } from "@/lib/donkey-api-auth";

const checkoutRequestSchema = z
  .object({
    amountDollars: z.coerce
      .number()
      .int()
      .min(creditTopUpMinDollars)
      .max(creditTopUpMaxDollars),
  })
  .strict();

// Start a one-time Stripe Checkout to buy credits. Session-only (no API keys).
// The card is saved (setup_future_usage) so auto-reload can charge it later.
export const POST = withDonkeyAuth(async (request) => {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return unauthorizedResponse();
  }

  const locale = requestLocale(request);
  const parsed = checkoutRequestSchema.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "credit_amount_out_of_range",
        message: `Choose between ${creditCountLabel(creditTopUpMinDollars * creditsPerDollar, locale)} and ${creditCountLabel(creditTopUpMaxDollars * creditsPerDollar, locale)}, in whole thousands.`,
      },
      { status: 400 },
    );
  }
  const amountDollars = parsed.data.amountDollars;

  const customerId = await ensureStripeCustomer({
    email: session.user.email,
    name: session.user.name,
    userId: session.user.id,
  });
  const stripe = getStripe();
  const t = await translatorFor(locale, "settings");
  const origin = request.nextUrl.origin;
  const metadata = {
    amountDollars: String(amountDollars),
    kind: creditTopUpKind,
    userId: session.user.id,
  };

  const checkout = await stripe.checkout.sessions.create({
    cancel_url: `${origin}/app/settings?topup=cancelled`,
    client_reference_id: session.user.id,
    customer: customerId,
    locale: STRIPE_LOCALE[locale],
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            description: creditCountLabel(amountDollars * creditsPerDollar, locale),
            name: t("checkout.creditsProduct"),
          },
          unit_amount: dollarsToStripeCents(amountDollars),
        },
        quantity: 1,
      },
    ],
    metadata: { ...metadata, ...metaCheckoutMetadata(request.headers) },
    mode: "payment",
    payment_intent_data: { metadata, setup_future_usage: "off_session" },
    success_url: `${origin}/app/settings?topup=success`,
  });

  if (!checkout.url) {
    return NextResponse.json(
      { error: "checkout_no_url", message: "Stripe did not return a URL." },
      { status: 502 },
    );
  }

  trackCheckoutStarted(checkout.id, "Credits", request.headers, session.user);
  return NextResponse.json({ url: checkout.url });
});
