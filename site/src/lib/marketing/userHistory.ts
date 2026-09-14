import { creditMicrosToString } from "@/lib/credits/amounts";
import { PROMOTION_OFFER_KINDS } from "@/lib/credits/offerKinds";
import { prisma } from "@/lib/prisma";

// One account's money and mail, as an operator reads it before writing to
// the person: every credit offer with when it reached them and when it was
// claimed, every grant that landed (the signup bonus among them), every
// email the site sent them, and the storage they hold. Each list is one
// indexed read bounded by the account, so the whole answer is a handful of
// small queries however large the tables grow.

export type UserHistoryPromotion = { id: string; name: string; subject: string };

export type UserHistoryOffer = {
  id: string;
  kind: string;
  promotion: UserHistoryPromotion | null;
  dollars: string;
  description: string | null;
  createdAt: string;
  emailSentAt: string | null;
  closesAt: string | null;
  claimedAt: string | null;
};

export type UserHistoryGrant = {
  id: string;
  source: string;
  dollars: string;
  remainingDollars: string;
  status: string;
  description: string | null;
  createdAt: string;
  expiresAt: string | null;
};

export type UserHistoryEmail = {
  id: string;
  kind: string;
  promotion: UserHistoryPromotion | null;
  // The credit offer this email carried, when it carried one.
  offerId: string | null;
  subject: string | null;
  sentAt: string;
  clickedAt: string | null;
};

export type UserHistory = {
  storageBytes: string;
  offers: UserHistoryOffer[];
  grants: UserHistoryGrant[];
  emails: UserHistoryEmail[];
};

// The mail a person can be said to have received: tests go to the operator
// and a forwarded reply is the person's own words coming back.
const RECEIVED_EMAIL_KINDS = ["promotion", "promotion-hand", "outreach", "credit-offer", "credit-expiry", "welcome"];

const EMAIL_CAP = 100;

// A promotion's offer is keyed on the promotion and the account, so the
// promotion is the id's first half.
function promotionIdOfOffer(offer: { id: string; kind: string }): string | null {
  if (!(PROMOTION_OFFER_KINDS as readonly string[]).includes(offer.kind)) return null;
  const at = offer.id.indexOf(":");
  return at > 0 ? offer.id.slice(0, at) : null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function readUserHistory(userId: string): Promise<UserHistory> {
  const [offers, grants, emails, storage] = await Promise.all([
    prisma.creditOffer.findMany({
      orderBy: { createdAt: "desc" },
      where: { userId },
    }),
    prisma.userCreditGrant.findMany({
      orderBy: { createdAt: "desc" },
      where: { userId },
    }),
    prisma.emailSend.findMany({
      orderBy: { sentAt: "desc" },
      select: {
        clickedAt: true,
        id: true,
        kind: true,
        payload: true,
        promotionId: true,
        sentAt: true,
      },
      take: EMAIL_CAP,
      where: { kind: { in: RECEIVED_EMAIL_KINDS }, state: "sent", userId },
    }),
    prisma.cutStorageUsage.findUnique({ select: { bytes: true }, where: { userId } }),
  ]);

  // The promotions behind offers and emails, read once for all of them.
  const promotionIds = new Set<string>();
  for (const offer of offers) {
    const id = promotionIdOfOffer(offer);
    if (id) promotionIds.add(id);
  }
  for (const email of emails) if (email.promotionId) promotionIds.add(email.promotionId);
  const promotions = new Map<string, UserHistoryPromotion>();
  if (promotionIds.size > 0) {
    const rows = await prisma.promotion.findMany({
      select: { id: true, name: true, subject: true },
      where: { id: { in: [...promotionIds] } },
    });
    for (const row of rows) promotions.set(row.id, row);
  }
  const promotionOf = (id: string | null) => (id ? (promotions.get(id) ?? null) : null);

  return {
    storageBytes: (storage?.bytes ?? BigInt(0)).toString(),
    offers: offers.map((offer) => ({
      id: offer.id,
      kind: offer.kind,
      promotion: promotionOf(promotionIdOfOffer(offer)),
      dollars: creditMicrosToString(offer.amountMicros),
      description: offer.description,
      createdAt: offer.createdAt.toISOString(),
      emailSentAt: iso(offer.emailSentAt),
      closesAt: iso(offer.closesAt),
      claimedAt: iso(offer.claimedAt),
    })),
    grants: grants.map((grant) => ({
      id: grant.id,
      source: grant.source,
      dollars: creditMicrosToString(grant.originalAmountMicros),
      remainingDollars: creditMicrosToString(grant.remainingAmountMicros),
      status: grant.status,
      description: grant.description,
      createdAt: grant.createdAt.toISOString(),
      expiresAt: iso(grant.expiresAt),
    })),
    emails: emails.flatMap((email) => {
      if (!email.sentAt) return [];
      const payload = email.payload as { offerId?: unknown; subject?: unknown } | null;
      const subject = typeof payload?.subject === "string" ? payload.subject : null;
      // A promotion's email and its offer share the promotion; a credit
      // offer's email names the offer.
      const offerId = email.promotionId
        ? (offers.find((offer) => promotionIdOfOffer(offer) === email.promotionId)?.id ?? null)
        : typeof payload?.offerId === "string"
          ? payload.offerId
          : null;
      return [
        {
          id: email.id,
          kind: email.kind,
          promotion: promotionOf(email.promotionId),
          offerId,
          subject,
          sentAt: email.sentAt.toISOString(),
          clickedAt: iso(email.clickedAt),
        },
      ];
    }),
  };
}
