import { NextResponse } from "next/server";

import { getStripe, portalConfigurationId } from "@/lib/billing/stripe";
import {
  donkeySessionUserId,
  notFoundResponse,
  unauthorizedResponse,
  withDonkeyAuth,
} from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

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
    return_url: `${request.nextUrl.origin}/app/settings`,
    ...(configuration ? { configuration } : {}),
  });

  return NextResponse.json({ url: portal.url });
});
