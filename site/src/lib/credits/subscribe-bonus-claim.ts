import { creditOfferOpen, landCreditOffer } from "@/lib/credits/offers";
import { prisma } from "@/lib/prisma";

// The subscribe bonus lands here, from the subscription webhook. A Pro
// checkout started while the account's offer was open carries the offer's
// id on the subscription it creates, so the claim is the checkout the person
// took up from the offer, however long Stripe took. The grant keys on the
// account, so the bonus lands once however many webhooks there are.

// The offer's kind, and the source of the grant it lands as.
export const SUBSCRIBE_BONUS_KIND = "subscribe_bonus";
export const SUBSCRIBE_BONUS_SOURCE = "subscribe_bonus";

// The subscription metadata key the checkout writes and the webhook reads.
export const SUBSCRIBE_BONUS_METADATA_KEY = "creditOfferId";

/** The account's offer if it can be taken up right now. */
export async function openSubscribeBonusOffer(userId: string, now = new Date()) {
  const offer = await prisma.creditOffer.findFirst({
    where: { userId, kind: SUBSCRIBE_BONUS_KIND },
    orderBy: { createdAt: "asc" },
  });
  return offer && creditOfferOpen(offer, now) ? offer : null;
}

export async function claimSubscribeBonus(userId: string, offerId: string) {
  const offer = await prisma.creditOffer.findUnique({ where: { id: offerId } });
  if (!offer || offer.userId !== userId || offer.kind !== SUBSCRIBE_BONUS_KIND) return null;
  return landCreditOffer(offer, {
    description: "Pro subscribe bonus",
    source: SUBSCRIBE_BONUS_SOURCE,
    sourceId: `subscribe-bonus:${userId}`,
  });
}
