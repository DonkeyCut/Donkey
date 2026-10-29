import { NextResponse } from "next/server";

import { introPriceCents } from "@/lib/billing/intro-offer";
import { openIntroOffer, previewIntroOffer, readProPriceCents } from "@/lib/billing/intro-offer-server";
import { contextFromRequest } from "@/lib/config/effective";
import { withDonkeyAuth } from "@/lib/donkey-api-auth";

// The intro offer, priced. The app loads it with GET as it starts, which
// never starts the offer's window, so a card that sells Pro paints with the
// offer on its first frame. The surface showing it then POSTs, and the first
// POST starts the window. The checkout reads the same offer and applies it.

// The offer on the wire. endsAt is null for a window that starts the moment
// a surface first shows it, and runs windowHours from there.
async function priced(offer: { percentOff: number; months: number; endsAt: Date | null; windowHours: number }) {
  const priceCents = await readProPriceCents();
  return {
    endsAt: offer.endsAt?.toISOString() ?? null,
    introCents: introPriceCents(priceCents, offer.percentOff),
    months: offer.months,
    percentOff: offer.percentOff,
    priceCents,
    windowHours: offer.windowHours,
  };
}

export const GET = withDonkeyAuth(async (request) => {
  const offer = await previewIntroOffer(await contextFromRequest(request));
  return NextResponse.json({ offer: offer ? await priced(offer) : null });
});

// Starts the window, the first time, and answers when it ends; null when no
// offer is open.
export const POST = withDonkeyAuth(async (request) => {
  const offer = await openIntroOffer(await contextFromRequest(request));
  return NextResponse.json({ endsAt: offer?.endsAt.toISOString() ?? null });
});
