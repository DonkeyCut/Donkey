import { NextResponse } from "next/server";
import { z } from "zod";

import { creditMicrosToString } from "@/lib/credits/amounts";
import { getCreditBalance } from "@/lib/credits/inference";
import {
  claimCreditOffer,
  CreditOfferNotYoursError,
  verifyCreditOfferToken,
} from "@/lib/credits/offers";
import { forbiddenResponse, notFoundResponse, withDonkeyAuth } from "@/lib/donkey-api-auth";

const claimRequestSchema = z.object({ token: z.string().min(1) }).strict();

// Claims a credit offer for the signed-in account. The token names the offer
// and proves the link came from its email; the session has to be the offered
// account's.
export const POST = withDonkeyAuth(async (request) => {
  const parsed = claimRequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const offerId = verifyCreditOfferToken(parsed.data.token);
  if (!offerId) return notFoundResponse();

  try {
    const claimed = await claimCreditOffer(offerId, request.donkey.userId);
    if (!claimed) return notFoundResponse();
    const balance = await getCreditBalance(request.donkey.userId);
    return NextResponse.json({
      balance: balance.balance,
      credits: creditMicrosToString(claimed.grant.originalAmountMicros),
      expiresAt: claimed.grant.expiresAt?.toISOString() ?? null,
    });
  } catch (error) {
    if (error instanceof CreditOfferNotYoursError) return forbiddenResponse();
    throw error;
  }
});
