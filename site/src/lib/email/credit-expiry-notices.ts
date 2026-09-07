import type { Prisma } from "@/generated/prisma/client";
import { creditMicrosToString, zeroCreditMicros } from "@/lib/credits/amounts";
import { bulkFrom, isResendConfigured, ResendNotConfiguredError } from "@/lib/email/resend";
import { sendCreditsExpiringEmail } from "@/lib/email/send-credits-expiring";
import { prisma } from "@/lib/prisma";

// The grants an account is warned about: credit it was given. Purchased
// credit never expires, and the Pro allowance turns over every month.
export const NOTICED_GRANT_SOURCES = ["signup", "manual_dollar"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

function metadataObject(metadata: Prisma.JsonValue | null): Prisma.JsonObject {
  return metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata
    : {};
}

/** Whether the grant's account has already been told this grant expires. */
export function expiryNoticed(metadata: Prisma.JsonValue | null): boolean {
  return typeof metadataObject(metadata).expiryNoticeSentAt === "string";
}

// Emails every account holding a given grant that expires inside the window,
// once per grant: the send is recorded on the grant's metadata, so the next
// run reaches only what this one missed. Credit on the account is account
// mail, so the marketing opt-out does not apply; the footer still offers it.
export async function sendDueCreditExpiryNotices(input: { now?: Date; withinDays: number }) {
  if (!isResendConfigured()) throw new ResendNotConfiguredError();
  if (!bulkFrom()) throw new Error("No bulk sender configured.");
  const now = input.now ?? new Date();
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
      expiresAt: { gt: now, lte: new Date(now.getTime() + input.withinDays * DAY_MS) },
      remainingAmountMicros: { gt: zeroCreditMicros },
      source: { in: [...NOTICED_GRANT_SOURCES] },
      status: "active",
    },
  });
  const pending = grants.filter((g) => !expiryNoticed(g.metadata));

  let sent = 0;
  let failed = 0;
  for (const grant of pending) {
    if (!grant.expiresAt) continue;
    try {
      await sendCreditsExpiringEmail(
        grant.user,
        creditMicrosToString(grant.remainingAmountMicros),
        grant.expiresAt,
        `credits-expiring:${grant.id}`,
      );
      await prisma.userCreditGrant.update({
        data: {
          metadata: {
            ...metadataObject(grant.metadata),
            expiryNoticeSentAt: new Date().toISOString(),
          },
        },
        where: { id: grant.id },
      });
      sent++;
    } catch (error) {
      failed++;
      console.error("[credit-expiry-notice] failed to send", { error, userId: grant.user.id });
    }
  }
  return { due: grants.length, failed, pending: pending.length, sent };
}
