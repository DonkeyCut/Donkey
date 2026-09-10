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

/** The ids most recently active first; accounts never seen using the
 * product come last, in the order given. */
export function byMostRecentlyActive<T extends { id: string }>(users: T[], lastActiveBy: Map<string, Date>): T[] {
  const at = (user: T) => lastActiveBy.get(user.id)?.getTime() ?? 0;
  return [...users].sort((a, b) => at(b) - at(a));
}
