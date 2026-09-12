import type { CreditOffer } from "@/generated/prisma/client";
import { isSubscribeClaimedKind, SUBSCRIBE_BONUS_KIND, SUBSCRIBE_CLAIMED_KINDS } from "@/lib/credits/offerKinds";
import { creditOfferOpen, landCreditOffer } from "@/lib/credits/offers";
import { prisma } from "@/lib/prisma";

// Credit that lands from a Pro subscription: the subscribe bonus the app opens
// on its own, and a promotion emailed with a subscribe claim. A Pro checkout
// started while such an offer is open carries the offer's id on the
// subscription it creates, so the claim is the checkout the person took up
// from the offer, however long Stripe took. The webhook lands it here.

// The source every subscription-landed grant carries.
export const SUBSCRIBE_BONUS_SOURCE = "subscribe_bonus";

// The subscription metadata key the checkout writes and the webhook reads.
export const SUBSCRIBE_BONUS_METADATA_KEY = "creditOfferId";

type Candidate = { amountMicros: bigint; claimedAt: Date | null; closesAt: Date | null; createdAt: Date };

/** Of an account's offers, the one a subscription lands now: one per
 * subscription, the largest open one, the earliest made among equals. */
export function bestOfferForSubscribing<T extends Candidate>(offers: T[], now: Date): T | null {
  let best: T | null = null;
  for (const offer of offers) {
    if (!creditOfferOpen(offer, now)) continue;
    if (
      !best ||
      offer.amountMicros > best.amountMicros ||
      (offer.amountMicros === best.amountMicros && offer.createdAt < best.createdAt)
    ) {
      best = offer;
    }
  }
  return best;
}

/** Every offer of the account that a subscription can land, oldest first. */
export function findOffersForSubscribing(userId: string) {
  return prisma.creditOffer.findMany({
    where: { userId, kind: { in: [...SUBSCRIBE_CLAIMED_KINDS] } },
    orderBy: { createdAt: "asc" },
  });
}

/** The offer a checkout started now carries: the one the person was looking
 * at, when it names one that is open and theirs; else the one the app shows,
 * so the dialog and the landing always agree. */
export async function openOfferForSubscribing(userId: string, offerId: string | null, now = new Date()) {
  const offers = await findOffersForSubscribing(userId);
  const named = offerId ? offers.find((offer) => offer.id === offerId) : undefined;
  return named && creditOfferOpen(named, now) ? named : bestOfferForSubscribing(offers, now);
}

/** The grant an offer lands as. The bonus keys on the account, so it lands
 * once however many offers a race opened; a promotion's keys on the offer. */
function grantFor(offer: CreditOffer) {
  return {
    description: offer.kind === SUBSCRIBE_BONUS_KIND ? "Pro subscribe bonus" : "Promotional AI credits",
    source: SUBSCRIBE_BONUS_SOURCE,
    sourceId: offer.kind === SUBSCRIBE_BONUS_KIND ? `subscribe-bonus:${offer.userId}` : `offer:${offer.id}`,
  };
}

export async function claimOfferBySubscribing(userId: string, offerId: string) {
  const offer = await prisma.creditOffer.findUnique({ where: { id: offerId } });
  if (!offer || offer.userId !== userId || !isSubscribeClaimedKind(offer.kind)) return null;
  return landCreditOffer(offer, grantFor(offer));
}
