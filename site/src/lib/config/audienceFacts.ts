import { cutLimitsForTier } from "@/cut/server/cloud/limits";
import { usageBytes } from "@/cut/server/cloud/usage";
import type { AudienceFact, AudienceFacts } from "@donkeycut/abexp";
import { PURCHASE_SOURCES } from "@/lib/config/purchases";
import { getActiveProSubscription } from "@/lib/billing/pro-subscription";
import { prisma } from "@/lib/prisma";

// Collects the facts an audience needs about one account, and only those: an
// experiment over countries costs no billing query, and an account that
// already holds every running experiment costs none at all.

const clampPercent = (x: number) => Math.min(100, Math.max(0, x));

export async function collectFacts(
  userId: string,
  known: { country: string | null; createdAt: Date },
  needs: Set<AudienceFact>,
): Promise<AudienceFacts> {
  const facts: AudienceFacts = {
    country: known.country,
    createdAt: known.createdAt,
    pro: false,
    paid: false,
    lastActiveAt: null,
    storageUsedPercent: null,
    creditsUsedPercent: null,
  };
  const wantsPro = needs.has("pro") || needs.has("storageUsedPercent");
  const [pro, paid, session, storage, credits] = await Promise.all([
    wantsPro ? getActiveProSubscription(userId) : null,
    needs.has("paid")
      ? prisma.userCreditGrant.count({ where: { userId, source: { in: [...PURCHASE_SOURCES] } } })
      : 0,
    needs.has("lastActiveAt")
      ? prisma.session.findFirst({ where: { userId }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } })
      : null,
    needs.has("storageUsedPercent")
      ? Promise.all([
          usageBytes(userId),
          prisma.user.findUnique({ where: { id: userId }, select: { superUser: true } }),
        ])
      : null,
    needs.has("creditsUsedPercent")
      ? prisma.userCreditAccount.findUnique({
          where: { userId },
          select: { lifetimeGrantedMicros: true, lifetimeChargedMicros: true },
        })
      : null,
  ]);
  facts.pro = pro !== null;
  facts.paid = paid > 0;
  facts.lastActiveAt = session?.updatedAt ?? null;
  if (storage) {
    const [bytes, user] = storage;
    const quota = cutLimitsForTier({ superUser: user?.superUser ?? false, pro: facts.pro }).storageBytes;
    facts.storageUsedPercent = quota === null ? null : clampPercent((100 * bytes) / quota);
  }
  if (credits) {
    const granted = Number(credits.lifetimeGrantedMicros);
    const charged = Number(credits.lifetimeChargedMicros);
    facts.creditsUsedPercent = granted > 0 ? clampPercent((100 * charged) / granted) : null;
  }
  return facts;
}
