import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { ensureStripeCustomer, getStripe } from "@/lib/billing/stripe";
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

  const parsed = checkoutRequestSchema.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_request",
        message: `Enter a whole-dollar amount between $${creditTopUpMinDollars} and $${creditTopUpMaxDollars}.`,
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
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            description: `$${amountDollars} of Donkey inference credits`,
            name: "Donkey credits",
          },
          unit_amount: dollarsToStripeCents(amountDollars),
        },
        quantity: 1,
      },
    ],
    metadata,
    mode: "payment",
    payment_intent_data: { metadata, setup_future_usage: "off_session" },
    success_url: `${origin}/app/settings?topup=success`,
  });

  if (!checkout.url) {
    return NextResponse.json(
      { error: "server-error", message: "Stripe did not return a URL." },
      { status: 502 },
    );
  }

  return NextResponse.json({ url: checkout.url });
});
