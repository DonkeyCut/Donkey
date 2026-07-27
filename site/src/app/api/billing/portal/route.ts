import { NextResponse } from "next/server";

import { getStripe, visionPortalConfigurationId } from "@/lib/billing/stripe";
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

  // Pro customers carry their Stripe id on User (ensureStripeCustomer);
  // early Vision-only customers may still have it on their subscription row.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { stripeCustomerId: true },
  });
  let customerId = user?.stripeCustomerId ?? null;
  if (!customerId) {
    const vision = await prisma.visionApiSubscription.findUnique({
      where: { userId },
      select: { stripeCustomerId: true },
    });
    customerId = vision?.stripeCustomerId ?? null;
  }
  if (!customerId) {
    return notFoundResponse();
  }

  const stripe = getStripe();
  const configuration = visionPortalConfigurationId();
  const portal = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${request.nextUrl.origin}/app/settings`,
    ...(configuration ? { configuration } : {}),
  });

  return NextResponse.json({ url: portal.url });
});
