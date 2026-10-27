import { NextResponse } from "next/server";

import { requestLocale } from "@/i18n/requestLocale";
import { getStripe, portalConfigurationId } from "@/lib/billing/stripe";
import { STRIPE_LOCALE } from "@/lib/billing/stripe-locale";
import {
  donkeySessionUserId,
  notFoundResponse,
  unauthorizedResponse,
  withDonkeyAuth,
} from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

// Open the Stripe billing portal for the signed-in customer.
export const POST = withDonkeyAuth(async (request) => {
  const userId = donkeySessionUserId(request);
  if (!userId) {
    return unauthorizedResponse();
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { stripeCustomerId: true },
  });
  const customerId = user?.stripeCustomerId ?? null;
  if (!customerId) {
    return notFoundResponse();
  }

  const stripe = getStripe();
  const configuration = portalConfigurationId();
  const portal = await stripe.billingPortal.sessions.create({
    customer: customerId,
    locale: STRIPE_LOCALE[requestLocale(request)],
    return_url: `${request.nextUrl.origin}/app/settings`,
    ...(configuration ? { configuration } : {}),
  });

  return NextResponse.json({ url: portal.url });
});
