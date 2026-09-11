import { prisma } from "@/lib/prisma";

// When each account last used the product. Model work and cloud editing are
// both use, so either one keeps an account looking as recent as it is.
// Housekeeping writes the storage counter on its own — GC sweeps, copy jobs,
// the render worker — so that timestamp says nothing about a person being
// there and is left out.
export async function lastActiveByUser(userIds: string[]): Promise<Map<string, Date>> {
  const lastActiveBy = new Map<string, Date>();
  if (userIds.length === 0) return lastActiveBy;
  const [billed, uploaded, edited] = await Promise.all([
    prisma.inferenceUsageEvent.groupBy({
      _max: { createdAt: true },
      by: ["userId"],
      where: { billingStatus: "charged", userId: { in: userIds } },
    }),
    prisma.cutMediaObject.groupBy({
      _max: { createdAt: true },
      by: ["userId"],
      where: { quotaExempt: false, uploadState: "complete", userId: { in: userIds } },
    }),
    prisma.cutProject.groupBy({
      _max: { updatedAt: true },
      by: ["userId"],
      where: { userId: { in: userIds } },
    }),
  ]);
  const touch = (userId: string, at: Date | null) => {
    const best = lastActiveBy.get(userId);
    if (at && (!best || at > best)) lastActiveBy.set(userId, at);
  };
  for (const row of billed) touch(row.userId, row._max.createdAt);
  for (const row of uploaded) touch(row.userId, row._max.createdAt);
  for (const row of edited) touch(row.userId, row._max.updatedAt);
  return lastActiveBy;
}

// The largest rank a row can hold: an account never seen using the product.
const NEVER_ACTIVE_RANK = 2 ** 31 - 1;

/** A promotion row's place in the queue: seconds since the account last used
 * the product, so the people most recently active go first however many
 * pages the segment was read in. */
export function activityRank(now: Date, lastActiveAt: Date | undefined): number {
  if (!lastActiveAt) return NEVER_ACTIVE_RANK;
  return Math.min(NEVER_ACTIVE_RANK, Math.max(0, Math.floor((now.getTime() - lastActiveAt.getTime()) / 1000)));
}
