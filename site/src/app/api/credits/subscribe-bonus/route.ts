import { NextResponse } from "next/server";

import { contextFromRequest } from "@/lib/config/effective";
import { readSubscribeBonusOffer } from "@/lib/credits/subscribe-bonus";
import { withDonkeyAuth } from "@/lib/donkey-api-auth";
import { HIDE_PROMOTIONS_FLAG } from "@/lib/feature-flags";
import { accountFlagEnabled } from "@/lib/feature-flags-server";

// The caller's subscribe bonus offer, opened on this read when the account
// has just crossed the share of its signup grant the offer waits for. A
// super user who has hidden promotions gets none, and this read opens none.
export const GET = withDonkeyAuth(async (request) => {
  if (await accountFlagEnabled(request.donkey.userId, HIDE_PROMOTIONS_FLAG)) {
    return NextResponse.json({ offer: null });
  }
  const ctx = await contextFromRequest(request);
  const offer = await readSubscribeBonusOffer(ctx);
  return NextResponse.json({ offer });
});
