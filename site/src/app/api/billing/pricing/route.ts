import { NextResponse } from "next/server";

import { chargeCurrency } from "@/lib/billing/charge-currency";
import { contextFromRequest } from "@/lib/config/effective";
import { withDonkeyAuth } from "@/lib/donkey-api-auth";

// What the account pays in. The app loads it as it starts, so every card that
// sells a plan paints in the right currency on its first frame.
export const GET = withDonkeyAuth(async (request) => {
  const ctx = await contextFromRequest(request);
  return NextResponse.json({ currency: await chargeCurrency(ctx.userId, ctx.country) });
});
