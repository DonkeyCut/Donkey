import { NextResponse } from "next/server";

import { contextFromRequest } from "@/lib/config/effective";
import { readSubscribeBonusOffer } from "@/lib/credits/subscribe-bonus";
import { withDonkeyAuth } from "@/lib/donkey-api-auth";

// The caller's subscribe bonus offer, opened on this read when the account
// has just crossed the share of its signup grant the offer waits for.
export const GET = withDonkeyAuth(async (request) => {
  const ctx = await contextFromRequest(request);
  const offer = await readSubscribeBonusOffer(ctx);
  return NextResponse.json({ offer });
});
