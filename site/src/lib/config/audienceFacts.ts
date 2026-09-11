import { cutLimitsForTier } from "@/cut/server/cloud/limits";
import type { AudienceFact, AudienceFacts } from "@donkeycut/abexp";
import { ACTIVE_PRO_STATUSES } from "@/lib/billing/pro-subscription";
import { PURCHASE_SOURCES } from "@/lib/config/purchases";
import { prisma } from "@/lib/prisma";

// Collects the facts an audience needs about a page of accounts, and only
// those: an experiment over countries costs no billing query, and an account
// that already holds every running experiment costs none at all. Each fact is
// one set query over the page, so a segment of any size costs a handful of
// statements per page and never one per person.

const clampPercent = (x: number) => Math.min(100, Math.max(0, x));

export type KnownUser = { id: string; country: string | null; createdAt: Date };

export async function collectFactsFor(
  users: KnownUser[],
  needs: Set<AudienceFact>,
): Promise<Map<string, AudienceFacts>> {
  const facts = new Map<string, AudienceFacts>();
  for (const user of users) {
    facts.set(user.id, {
      country: user.country,
      createdAt: user.createdAt,
      pro: false,
      paid: false,
      lastActiveAt: null,
      storageUsedPercent: null,
      creditsUsedPercent: null,
    });
  }
  if (users.length === 0) return facts;
  const ids = users.map((u) => u.id);
  const wantsPro = needs.has("pro") || needs.has("storageUsedPercent");
  const [pro, paid, sessions, storage, credits] = await Promise.all([
    wantsPro
      ? prisma.proSubscription.findMany({
          select: { userId: true },
          where: { status: { in: [...ACTIVE_PRO_STATUSES] }, userId: { in: ids } },
        })
      : [],
    needs.has("paid")
      ? prisma.userCreditGrant.findMany({
          distinct: ["userId"],
          select: { userId: true },
          where: { source: { in: [...PURCHASE_SOURCES] }, userId: { in: ids } },
        })
      : [],
    needs.has("lastActiveAt")
      ? prisma.session.groupBy({ _max: { updatedAt: true }, by: ["userId"], where: { userId: { in: ids } } })
      : [],
    needs.has("storageUsedPercent")
      ? Promise.all([
          prisma.cutStorageUsage.findMany({ select: { bytes: true, userId: true }, where: { userId: { in: ids } } }),
          prisma.user.findMany({ select: { id: true, superUser: true }, where: { id: { in: ids } } }),
        ])
      : null,
    needs.has("creditsUsedPercent")
      ? prisma.userCreditAccount.findMany({
          select: { lifetimeChargedMicros: true, lifetimeGrantedMicros: true, userId: true },
          where: { userId: { in: ids } },
        })
      : [],
  ]);
  for (const row of pro) facts.get(row.userId)!.pro = true;
  for (const row of paid) facts.get(row.userId)!.paid = true;
  for (const row of sessions) facts.get(row.userId)!.lastActiveAt = row._max.updatedAt;
  if (storage) {
    const [usage, tiers] = storage;
    const bytesBy = new Map(usage.map((row) => [row.userId, Number(row.bytes)]));
    for (const tier of tiers) {
      const fact = facts.get(tier.id)!;
      const quota = cutLimitsForTier({ superUser: tier.superUser, pro: fact.pro }).storageBytes;
      fact.storageUsedPercent = quota === null ? null : clampPercent((100 * (bytesBy.get(tier.id) ?? 0)) / quota);
    }
  }
  for (const row of credits) {
    const granted = Number(row.lifetimeGrantedMicros);
    const charged = Number(row.lifetimeChargedMicros);
    facts.get(row.userId)!.creditsUsedPercent = granted > 0 ? clampPercent((100 * charged) / granted) : null;
  }
  return facts;
}

/** The facts for one account, as a request resolving its experiments reads them. */
export async function collectFacts(
  userId: string,
  known: { country: string | null; createdAt: Date },
  needs: Set<AudienceFact>,
): Promise<AudienceFacts> {
  const facts = await collectFactsFor([{ id: userId, ...known }], needs);
  return facts.get(userId)!;
}
