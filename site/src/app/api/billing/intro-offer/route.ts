import { NextResponse } from "next/server";

import { introPriceCents } from "@/lib/billing/intro-offer";
import { readIntroOffer, readProPriceCents } from "@/lib/billing/intro-offer-server";
import { contextFromRequest } from "@/lib/config/effective";
import { withDonkeyAuth } from "@/lib/donkey-api-auth";

// The intro offer open to the caller, priced, for the surfaces that sell Pro.
// The checkout reads the same offer and applies it.
export const GET = withDonkeyAuth(async (request) => {
  const offer = await readIntroOffer(await contextFromRequest(request));
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
