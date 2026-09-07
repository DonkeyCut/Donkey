import { createHmac, timingSafeEqual } from "node:crypto";

import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";
import { grantCredits } from "@/lib/credits/inference";
import { creditGrantExpiry } from "@/lib/credits/top-up";
import { sendCreditsOfferedEmail } from "@/lib/email/send-credits-offered";
import { prisma } from "@/lib/prisma";

// Claim links authenticate with an HMAC over the offer id, keyed by a
// domain-separated derivation of the auth secret, the same shape as the
// unsubscribe link. The claim itself also needs the offered account's session.
const TOKEN_DOMAIN = "donkey-credit-offer-v1";

function signature(offerId: string): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not set.");
  const key = createHmac("sha256", secret).update(TOKEN_DOMAIN).digest();
  return createHmac("sha256", key).update(offerId).digest();
}

export function creditOfferToken(offerId: string): string {
  return `${offerId}.${signature(offerId).toString("base64url")}`;
}

export function verifyCreditOfferToken(token: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const offerId = token.slice(0, dot);
  const expected = signature(offerId);
  const given = Buffer.from(token.slice(dot + 1), "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return offerId;
}

export function creditOfferClaimUrl(offerId: string): string {
  return `${DONKEYCUT_CANONICAL}/claim?token=${encodeURIComponent(creditOfferToken(offerId))}`;
}

// Records the offer and emails the claim link. The row comes first so the
// link can name it, and stays if the send fails: the next attempt with the
// same recipient, amount and lifetime picks the unsent offer up again, and
// the send keys on the offer id, so the person gets one link however many
// times the operator retries.
export async function createCreditOffer(input: {
  amountMicros: bigint;
  description?: string;
  expiresAfterDays: number | null;
  offeredByUserId: string;
  user: { email: string; id: string; name: string };
}) {
  const offer =
    (await prisma.creditOffer.findFirst({
      where: {
        amountMicros: input.amountMicros,
        claimedAt: null,
        emailSentAt: null,
        expiresAfterDays: input.expiresAfterDays,
        userId: input.user.id,
      },
    })) ??
    (await prisma.creditOffer.create({
      data: {
        amountMicros: input.amountMicros,
        description: input.description,
        expiresAfterDays: input.expiresAfterDays,
        offeredByUserId: input.offeredByUserId,
        userId: input.user.id,
      },
    }));
  await sendCreditsOfferedEmail(input.user, {
    amountMicros: offer.amountMicros,
    claimUrl: creditOfferClaimUrl(offer.id),
    expiresAfterDays: offer.expiresAfterDays,
    id: offer.id,
  });
  return prisma.creditOffer.update({
    data: { emailSentAt: new Date() },
    where: { id: offer.id },
  });
}

export class CreditOfferNotYoursError extends Error {}

// Makes the grant for a claimed offer. The grant dedupes on the offer id, so
// a second click returns the first claim.
export async function claimCreditOffer(offerId: string, userId: string) {
  const offer = await prisma.creditOffer.findUnique({ where: { id: offerId } });
  if (!offer) return null;
  if (offer.userId !== userId) throw new CreditOfferNotYoursError();
  if (offer.claimedAt && offer.grantId) {
    const grant = await prisma.userCreditGrant.findUnique({ where: { id: offer.grantId } });
    if (grant) return { grant, offer };
  }
  const grant = await grantCredits({
    amountMicros: offer.amountMicros,
    description: offer.description ?? "Manual credit grant",
    expiresAt: creditGrantExpiry(offer.expiresAfterDays),
    metadata: { expiresAfterDays: offer.expiresAfterDays, offerId: offer.id, offeredByUserId: offer.offeredByUserId },
    source: "manual_dollar",
    sourceId: `offer:${offer.id}`,
    userId,
  });
  const claimed = await prisma.creditOffer.update({
    data: { claimedAt: new Date(), grantId: grant.id },
    where: { id: offer.id },
  });
  return { grant, offer: claimed };
}
