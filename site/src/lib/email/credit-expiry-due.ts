import type { Prisma } from "@/generated/prisma/client";
import { zeroCreditMicros } from "@/lib/credits/amounts";
import { prisma } from "@/lib/prisma";

// The grants an account is warned about: credit it was given. Purchased
// credit never expires, and the Pro allowance turns over every month.
export const NOTICED_GRANT_SOURCES = ["signup", "manual_dollar", "subscribe_bonus"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export function metadataObject(metadata: Prisma.JsonValue | null): Prisma.JsonObject {
  return metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata
    : {};
}

/** Whether the grant's account has already been told this grant expires. */
export function expiryNoticed(metadata: Prisma.JsonValue | null): boolean {
  return typeof metadataObject(metadata).expiryNoticeSentAt === "string";
}

/** Grants still owed an expiry notice: expiring inside the window, holding
 * credit, and never noticed. */
export async function pendingCreditExpiryGrants(now: Date, withinDays: number) {
  const grants = await prisma.userCreditGrant.findMany({
    orderBy: { expiresAt: "asc" },
    select: {
      id: true,
      expiresAt: true,
      metadata: true,
      remainingAmountMicros: true,
      user: { select: { email: true, id: true, name: true } },
    },
    where: {
      expiresAt: { gt: now, lte: new Date(now.getTime() + withinDays * DAY_MS) },
      remainingAmountMicros: { gt: zeroCreditMicros },
      source: { in: [...NOTICED_GRANT_SOURCES] },
      status: "active",
    },
  });
  return { due: grants.length, pending: grants.filter((g) => !expiryNoticed(g.metadata)) };
}
