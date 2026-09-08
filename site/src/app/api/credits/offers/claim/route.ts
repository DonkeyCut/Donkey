import { NextResponse } from "next/server";
import { z } from "zod";

import { creditMicrosToString } from "@/lib/credits/amounts";
import { formatUsdPlain } from "@/lib/credits/format-usd";
import { getCreditBalance } from "@/lib/credits/inference";
import {
  claimCreditOffer,
  CreditOfferClosedError,
  CreditOfferNotYoursError,
  creditOfferOpen,
  MANUAL_OFFER_KIND,
  verifyCreditOfferToken,
} from "@/lib/credits/offers";
import { describeCreditLifetime } from "@/lib/email/send-credits-offered";
import { forbiddenResponse, notFoundResponse, withDonkeyAuth } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

const claimRequestSchema = z.object({ token: z.string().min(1) }).strict();

// Describes the offer a claim link names, for the dialog that presents it.
// The token proves the link came from the offer's email; the session has to be
// the offered account's, and a different account is told so before it tries.
// An offer whose claim window closed unclaimed is gone (410).
const goneResponse = () => NextResponse.json({ error: "This offer has closed." }, { status: 410 });
export const GET = withDonkeyAuth(async (request) => {
  const token = request.nextUrl.searchParams.get("token");
  const offerId = token ? verifyCreditOfferToken(token) : null;
  if (!offerId) return notFoundResponse();
  const offer = await prisma.creditOffer.findUnique({
    select: {
      amountMicros: true,
      claimedAt: true,
      closesAt: true,
      expiresAfterDays: true,
      grant: { select: { expiresAt: true } },
      kind: true,
      userId: true,
    },
    where: { id: offerId },
  });
  if (!offer || offer.kind !== MANUAL_OFFER_KIND) return notFoundResponse();
  if (offer.userId !== request.donkey.userId) return forbiddenResponse();
  if (!offer.claimedAt && !creditOfferOpen(offer, new Date())) return goneResponse();
  return NextResponse.json({
    claimed: offer.claimedAt !== null,
    closesAt: offer.closesAt?.toISOString() ?? null,
    credits: formatUsdPlain(creditMicrosToString(offer.amountMicros)),
    expiresAt: offer.grant?.expiresAt?.toISOString() ?? null,
    lifetime: describeCreditLifetime(offer.expiresAfterDays),
  });
});

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
    if (error instanceof CreditOfferClosedError) return goneResponse();
    throw error;
  }
});
