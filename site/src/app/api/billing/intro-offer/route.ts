import { NextResponse } from "next/server";

import { introPriceCents } from "@/lib/billing/intro-offer";
import { openIntroOffer, readProPriceCents } from "@/lib/billing/intro-offer-server";
import { contextFromRequest } from "@/lib/config/effective";
import { withDonkeyAuth } from "@/lib/donkey-api-auth";

// The intro offer, priced, for a surface that sells Pro and is showing it.
// The first call starts the offer's window, so it is a POST. The checkout
// reads the same offer and applies it.
export const POST = withDonkeyAuth(async (request) => {
  const offer = await openIntroOffer(await contextFromRequest(request));
  if (!offer) {
    return NextResponse.json({ offer: null });
  }

  const priceCents = await readProPriceCents();
  return NextResponse.json({
    offer: {
      endsAt: offer.endsAt.toISOString(),
      introCents: introPriceCents(priceCents, offer.percentOff),
      months: offer.months,
      percentOff: offer.percentOff,
      priceCents,
    },
  });
});
