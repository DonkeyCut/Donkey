import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { proPriceId } from "@/lib/billing/pro-subscription";
import { ensureStripeCustomer, getStripe } from "@/lib/billing/stripe";
import { verifyCreditOfferToken } from "@/lib/credits/offers";
import { openOfferForSubscribing, SUBSCRIBE_BONUS_METADATA_KEY } from "@/lib/credits/subscribe-bonus-claim";
import {
  notFoundResponse,
  unauthorizedResponse,
  withDonkeyAuth,
} from "@/lib/donkey-api-auth";

// A checkout opened from an offer's claim link names the offer by its token,
// so the credit that lands is the one the dialog described. No body is a
// checkout from anywhere else.
const bodySchema = z.object({ offerToken: z.string().min(1).optional() }).strict();

// Start a Stripe Checkout session for a Pro subscription. This route keeps its
// getSession call because it needs the user's email/name.
export const POST = withDonkeyAuth(async (request) => {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return unauthorizedResponse();
  }
  const text = await request.text();
  const parsed = bodySchema.safeParse(text ? JSON.parse(text) : {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const namedOfferId = parsed.data.offerToken ? verifyCreditOfferToken(parsed.data.offerToken) : null;

  // A not-yet-configured price stays a 404 (not 401) so the landing card does
  // not treat it as a sign-in prompt.
  const priceId = proPriceId();
  if (!priceId) {
    return notFoundResponse();
  }

  const customerId = await ensureStripeCustomer({
    email: session.user.email,
    name: session.user.name,
    userId: session.user.id,
  });
  // A checkout started while an offer for subscribing is open carries the
  // offer, so the webhook lands the credit on the subscription it creates.
  const offer = await openOfferForSubscribing(session.user.id, namedOfferId);
  const stripe = getStripe();
  const origin = request.nextUrl.origin;
  const checkout = await stripe.checkout.sessions.create({
    allow_promotion_codes: true,
    cancel_url: `${origin}/app/settings?checkout=cancelled`,
    client_reference_id: session.user.id,
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    mode: "subscription",
    subscription_data: {
      metadata: {
        userId: session.user.id,
        ...(offer ? { [SUBSCRIBE_BONUS_METADATA_KEY]: offer.id } : {}),
      },
    },
    success_url: `${origin}/app/settings?checkout=success`,
  });

  if (!checkout.url) {
    return NextResponse.json(
      { error: "server-error", message: "Stripe did not return a URL." },
      { status: 502 },
    );
  }

  return NextResponse.json({ url: checkout.url });
});
