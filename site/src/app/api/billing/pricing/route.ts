import { NextResponse } from "next/server";

import { chargeCurrency } from "@/lib/billing/charge-currency";
import { toMinor } from "@/lib/billing/currencies";
import { introPriceMinor } from "@/lib/billing/intro-offer";
import { previewIntroOffer } from "@/lib/billing/intro-offer-server";
import { planPrice } from "@/lib/billing/plans";
import { contextFromRequest, getGlobalSetting } from "@/lib/config/effective";
import { withDonkeyAuth } from "@/lib/donkey-api-auth";

// What the account pays in and the intro offer open to it, priced in that
// currency. The app loads it as it starts, so every card that sells a plan
// paints in the right currency, with the offer, on its first frame. Reading
// never starts the offer's window; the intro offer route's POST does.
//
// endsAt is null for a window that starts the moment a surface first shows
// it, and runs windowHours from there.
export const GET = withDonkeyAuth(async (request) => {
  const ctx = await contextFromRequest(request);
  const [currency, offer, terms] = await Promise.all([
    chargeCurrency(ctx.userId, ctx.country),
    previewIntroOffer(ctx),
    getGlobalSetting("planTerms"),
  ]);
  if (!offer) {
    return NextResponse.json({ currency, intro: null });
  }

  const priceMinor = toMinor(planPrice(terms.pro, currency), currency);
  return NextResponse.json({
    currency,
    intro: {
      currency,
      endsAt: offer.endsAt?.toISOString() ?? null,
      introMinor: introPriceMinor(priceMinor, offer.percentOff),
      months: offer.months,
      percentOff: offer.percentOff,
      priceMinor,
      windowHours: offer.windowHours,
    },
  });
});
