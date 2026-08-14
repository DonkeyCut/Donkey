import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { proPriceId } from "@/lib/billing/pro-subscription";
import { ensureStripeCustomer, getStripe } from "@/lib/billing/stripe";
import {
  notFoundResponse,
  unauthorizedResponse,
  withDonkeyAuth,
} from "@/lib/donkey-api-auth";

export const dynamic = "force-dynamic";

// Start a Stripe Checkout session for a Pro subscription. This route keeps its
// getSession call because it needs the user's email/name.
export const POST = withDonkeyAuth(async (request) => {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return unauthorizedResponse();
  }

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
  const stripe = getStripe();
  const origin = request.nextUrl.origin;
  const checkout = await stripe.checkout.sessions.create({
    allow_promotion_codes: true,
    cancel_url: `${origin}/app/settings?checkout=cancelled`,
    client_reference_id: session.user.id,
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    mode: "subscription",
    subscription_data: { metadata: { userId: session.user.id } },
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
