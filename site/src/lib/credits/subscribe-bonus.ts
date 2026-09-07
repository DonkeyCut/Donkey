import type { CreditOffer } from "@/generated/prisma/client";
import { getActiveProSubscription } from "@/lib/billing/pro-subscription";
import { getSetting, type ConfigContext } from "@/lib/config/effective";
import { creditMicrosToString, creditStringToMicros, zeroCreditMicros } from "@/lib/credits/amounts";
import { creditOfferOpen } from "@/lib/credits/offers";
import { SUBSCRIBE_BONUS_KIND } from "@/lib/credits/subscribe-bonus-claim";
import { prisma } from "@/lib/prisma";

// The subscribe bonus: an account that has spent enough of its signup grant
// is offered credit for subscribing to Pro within a window. The offer is a
// credit offer of this kind, opened on the first read that finds the account
// past the share; it lands from the subscription webhook
// (src/lib/credits/subscribe-bonus-claim.ts).

export const SIGNUP_GRANT_SOURCE = "signup";

export type SubscribeBonusStatus = "open" | "closed" | "claimed";

export type SubscribeBonusView = {
  // USD, as a credit string.
  dollars: string;
  openedAt: string;
  closesAt: string;
  creditsExpireAt: string | null;
  status: SubscribeBonusStatus;
};

/** The last moment of a UTC day named as YYYY-MM-DD. */
export function endOfUtcDay(day: string): Date {
  return new Date(`${day}T23:59:59.999Z`);
}

/** Whether a grant is spent past the share the offer waits for. Credit that
 * lapsed at expiry was never spent, so it comes off the spent side. */
export function crossedSpentShare(
  grant: { originalAmountMicros: bigint; remainingAmountMicros: bigint },
  lapsedMicros: bigint,
  spentPercent: number,
): boolean {
  if (grant.originalAmountMicros <= zeroCreditMicros) return false;
  const spent = grant.originalAmountMicros - grant.remainingAmountMicros - lapsedMicros;
  return spent * BigInt(100) >= grant.originalAmountMicros * BigInt(spentPercent);
}

/** An offer is open while it can still be taken up: unclaimed, inside its
 * window, and by an account that does not already hold Pro. */
export function subscribeBonusStatus(
  offer: { closesAt: Date | null; claimedAt: Date | null },
  facts: { now: Date; pro: boolean },
): SubscribeBonusStatus {
  if (offer.claimedAt) return "claimed";
  return !facts.pro && creditOfferOpen(offer, facts.now) ? "open" : "closed";
}

export function subscribeBonusView(offer: CreditOffer, facts: { now: Date; pro: boolean }): SubscribeBonusView {
  return {
    dollars: creditMicrosToString(offer.amountMicros),
    openedAt: offer.createdAt.toISOString(),
    closesAt: (offer.closesAt ?? offer.createdAt).toISOString(),
    creditsExpireAt: offer.expiresAt?.toISOString() ?? null,
    status: subscribeBonusStatus(offer, facts),
  };
}

/** Whether credit expiring at the day's end outlives the whole window, so a
 * subscription at the last minute of the window still lands live credit. */
export function creditOutlivesWindow(expiresAt: Date | null, closesAt: Date): boolean {
  return expiresAt === null || expiresAt.getTime() > closesAt.getTime();
}

/** The account's offer of this kind: the earliest, so two first reads that
 * raced agree on which one stands. */
export function findSubscribeBonusOffer(userId: string) {
  return prisma.creditOffer.findFirst({
    where: { userId, kind: SUBSCRIBE_BONUS_KIND },
    orderBy: { createdAt: "asc" },
  });
}

/** The account's offer as it stands, opening it when the account has just
 * crossed the share. Null while there is nothing to offer: the setting makes
 * no offer for this account, the account holds Pro, or the signup grant is
 * not yet spent far enough. */
export async function readSubscribeBonusOffer(ctx: ConfigContext, now = new Date()): Promise<SubscribeBonusView | null> {
  if (!ctx.hasAccount) return null;
  // The indexed reads come first: the offer row, then the two facts that rule
  // most accounts out before the configuration is resolved.
  const [existing, pro, grant] = await Promise.all([
    findSubscribeBonusOffer(ctx.userId),
    getActiveProSubscription(ctx.userId),
    prisma.userCreditGrant.findFirst({
      where: { userId: ctx.userId, source: SIGNUP_GRANT_SOURCE },
      select: { id: true, originalAmountMicros: true, remainingAmountMicros: true },
    }),
  ]);
  const facts = { now, pro: pro !== null };
  if (existing) return subscribeBonusView(existing, facts);
  if (pro || !grant || grant.remainingAmountMicros >= grant.originalAmountMicros) return null;

  const setting = await getSetting("subscribeBonus", ctx);
  if (setting.dollars <= 0) return null;
  const lapsed = await prisma.userCreditLedgerEntry.aggregate({
    _sum: { amountMicros: true },
    where: { grantId: grant.id, type: "expiration" },
  });
  const lapsedMicros = -(lapsed._sum.amountMicros ?? zeroCreditMicros);
  if (!crossedSpentShare(grant, lapsedMicros, setting.spentPercent)) return null;

  // A promise of credit that would be dead by the time it lands is no offer:
  // the setting's last day has to lie past the whole window.
  const closesAt = new Date(now.getTime() + setting.windowHours * 60 * 60 * 1000);
  const expiresAt = setting.creditsExpireOn ? endOfUtcDay(setting.creditsExpireOn) : null;
  if (!creditOutlivesWindow(expiresAt, closesAt)) return null;

  await prisma.creditOffer.create({
    data: {
      amountMicros: creditStringToMicros(String(setting.dollars)),
      closesAt,
      createdAt: now,
      description: "Pro subscribe bonus",
      expiresAt,
      kind: SUBSCRIBE_BONUS_KIND,
      userId: ctx.userId,
    },
  });
  const row = await findSubscribeBonusOffer(ctx.userId);
  return row ? subscribeBonusView(row, facts) : null;
}
