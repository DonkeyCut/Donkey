import { NextResponse } from "next/server";

import { openIntroOffer } from "@/lib/billing/intro-offer-server";
import { contextFromRequest } from "@/lib/config/effective";
import { withDonkeyAuth } from "@/lib/donkey-api-auth";

// The surface showing the intro offer POSTs here; the first POST starts the
// offer's window. It answers when the window ends, null when no offer is
// open. The app reads the offer itself from the pricing route, and checkout
// reads the same offer and applies it.
export const POST = withDonkeyAuth(async (request) => {
  const offer = await openIntroOffer(await contextFromRequest(request));
  return NextResponse.json({ endsAt: offer?.endsAt.toISOString() ?? null });
});
