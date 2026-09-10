import { createHmac, timingSafeEqual } from "node:crypto";

import type { CreditOffer } from "@/generated/prisma/client";
import { CUT_APP_BASE } from "@/cut/lib/appBase";
import { getGlobalSetting } from "@/lib/config/effective";
import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";
import { grantCredits } from "@/lib/credits/inference";
import { creditGrantExpiry } from "@/lib/credits/top-up";
import { deliverEmail } from "@/lib/email/outbox";
import { creditsOfferedIdempotencyKey } from "@/lib/email/send-credits-offered";
import { prisma } from "@/lib/prisma";

// Claim links authenticate with an HMAC over the offer id, keyed by a
// domain-separated derivation of the auth secret, the same shape as the
// unsubscribe link. The claim itself also needs the offered account's session.
const TOKEN_DOMAIN = "donkey-credit-offer-v1";

// The kind su makes by hand; a promotion's offers carry the promotion's key.
export const MANUAL_OFFER_KIND = "manual";
// The kind of an offer a promotion email made; its id is `${promotionId}:${userId}`.
export const PROMOTION_OFFER_KIND = "promotion_email";

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

// The claim link opens the app with the token in the address; the app's home
// reads it and presents the offer in a dialog (ClaimCreditsDialog).
export function creditOfferClaimUrl(offerId: string): string {
  return `${DONKEYCUT_CANONICAL}${CUT_APP_BASE}?claim=${encodeURIComponent(creditOfferToken(offerId))}`;
}

/** The last moment a claim link sent now can be used. */
export function manualOfferClosesAt(claimWindowDays: number, now = new Date()): Date {
  return new Date(now.getTime() + claimWindowDays * 24 * 60 * 60 * 1000);
}

// Records the offer and emails the claim link. The row comes first so the
// link can name it, and stays if the send fails: the next attempt with the
// same recipient, amount and lifetime picks the unsent offer up again, and
// the send keys on the offer id, so the person gets one link however many
// times the operator retries. The claim window runs from the send.
export async function createCreditOffer(input: {
  amountMicros: bigint;
  description?: string;
  expiresAfterDays: number | null;
  offeredByUserId: string;
  user: { email: string; id: string; name: string };
}) {
  const { claimWindowDays } = await getGlobalSetting("manualCreditOffer");
  const closesAt = manualOfferClosesAt(claimWindowDays);
  const offer =
    (await prisma.creditOffer.findFirst({
      where: {
        amountMicros: input.amountMicros,
        claimedAt: null,
        emailSentAt: null,
        expiresAfterDays: input.expiresAfterDays,
        kind: MANUAL_OFFER_KIND,
        userId: input.user.id,
      },
    })) ??
    (await prisma.creditOffer.create({
      data: {
        amountMicros: input.amountMicros,
        closesAt,
        description: input.description,
        expiresAfterDays: input.expiresAfterDays,
        kind: MANUAL_OFFER_KIND,
        offeredByUserId: input.offeredByUserId,
        userId: input.user.id,
      },
    }));
  await prisma.creditOffer.update({ data: { closesAt }, where: { id: offer.id } });
  const delivery = await deliverEmail({
    idempotencyKey: creditsOfferedIdempotencyKey(offer.id),
    kind: "credit-offer",
    payload: { offerId: offer.id },
    userId: input.user.id,
  });
  return { delivery, offer: await prisma.creditOffer.findUniqueOrThrow({ where: { id: offer.id } }) };
}

export class CreditOfferNotYoursError extends Error {}

// The claim window closed before the link was used.
export class CreditOfferClosedError extends Error {}

/** Whether an offer can still be claimed now. */
export function creditOfferOpen(offer: { claimedAt: Date | null; closesAt: Date | null }, now: Date): boolean {
  return offer.claimedAt === null && (offer.closesAt === null || now.getTime() <= offer.closesAt.getTime());
}

/** Lands an offer as a grant and records the claim. The grant dedupes on
 * its source id, so landing twice returns the first grant; a kind whose
 * offers must land once per account keys the id on the account. */
export async function landCreditOffer(
  offer: CreditOffer,
  grant: { source: string; sourceId: string; description: string },
) {
  if (offer.claimedAt && offer.grantId) {
    const existing = await prisma.userCreditGrant.findUnique({ where: { id: offer.grantId } });
    if (existing) return { grant: existing, offer };
  }
  const landed = await grantCredits({
    amountMicros: offer.amountMicros,
    description: offer.description ?? grant.description,
    expiresAt: offer.expiresAt ?? creditGrantExpiry(offer.expiresAfterDays),
    metadata: { kind: offer.kind, offerId: offer.id, offeredByUserId: offer.offeredByUserId },
    source: grant.source,
    sourceId: grant.sourceId,
    userId: offer.userId,
  });
  const claimed = await prisma.creditOffer.update({
    data: { claimedAt: new Date(), grantId: landed.id },
    where: { id: offer.id },
  });
  return { grant: landed, offer: claimed };
}

// Claims an offer from its email link: the ones su sends by hand and the ones
// a promotion mails. Every other kind lands from the act it rewards.
export async function claimCreditOffer(offerId: string, userId: string) {
  const offer = await prisma.creditOffer.findUnique({ where: { id: offerId } });
  if (!offer || (offer.kind !== MANUAL_OFFER_KIND && offer.kind !== PROMOTION_OFFER_KIND)) return null;
  if (offer.userId !== userId) throw new CreditOfferNotYoursError();
  if (!offer.claimedAt && !creditOfferOpen(offer, new Date())) throw new CreditOfferClosedError();
  return landCreditOffer(offer, {
    description: "Manual credit grant",
    source: "manual_dollar",
    sourceId: `offer:${offer.id}`,
  });
}

export async function createPromotionCreditOffer(input: {
  promotionId: string;
  userId: string;
  amountDollars: number;
  claimWindowDays: number;
  expiresAfterDays: number;
  offeredByUserId: string | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const offerId = `${input.promotionId}:${input.userId}`;
  const offer = await prisma.creditOffer.upsert({
    where: { id: offerId },
    create: {
      id: offerId,
      userId: input.userId,
      kind: PROMOTION_OFFER_KIND,
      amountMicros: BigInt(input.amountDollars) * BigInt(1_000_000),
      expiresAfterDays: input.expiresAfterDays,
      closesAt: new Date(now.getTime() + input.claimWindowDays * 86_400_000),
      description: "Promotional AI credits",
      offeredByUserId: input.offeredByUserId,
    },
    update: {},
  });
  return { offer, claimUrl: creditOfferClaimUrl(offer.id) };
}
