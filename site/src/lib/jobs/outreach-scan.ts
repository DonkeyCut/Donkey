import { z } from "zod";

import { ACTIVE_PRO_STATUSES } from "@/lib/billing/pro-subscription";
import { zeroCreditMicros } from "@/lib/credits/amounts";
import { defineJob } from "@/lib/jobs/registry";
import {
  CREDIT_SPENDERS_CAMPAIGN,
  OUTREACH_ACTIVE_WINDOW_DAYS,
  OUTREACH_RECONTACT_DAYS,
} from "@/lib/marketing/campaigns";
import { prisma } from "@/lib/prisma";

const DAY_MS = 24 * 60 * 60 * 1000;
// Upserts go out in batches so one scan is a handful of round trips.
const BATCH = 50;

// Rolls credit usage into the outreach list. Runs nightly from
// /api/marketing/outreach/scan and by hand from the Outreach tab's Scan now
// button. Everything the /su page shows is written here, so the page itself
// never touches the credit tables.
export const outreachScanJob = defineJob(z.object({}).strict(), async () => {
  const startedAt = new Date();
  const since = new Date(startedAt.getTime() - OUTREACH_ACTIVE_WINDOW_DAYS * DAY_MS);
  const recontactBefore = new Date(startedAt.getTime() - OUTREACH_RECONTACT_DAYS * DAY_MS);
  const campaign = CREDIT_SPENDERS_CAMPAIGN;

  // Free accounts that have spent credits and are still warm. Any amount of
  // spend qualifies; what is left is a column on the row, not a filter.
  const accounts = await prisma.userCreditAccount.findMany({
    select: { balanceMicros: true, lifetimeChargedMicros: true, userId: true },
    where: {
      lifetimeChargedMicros: { gt: zeroCreditMicros },
      user: {
        // An account with no settings row has never opted out.
        OR: [
          { emailSettings: { is: null } },
          { emailSettings: { is: { marketingUnsubscribedAt: null } } },
        ],
        NOT: {
          proSubscription: { is: { status: { in: [...ACTIVE_PRO_STATUSES] } } },
        },
        inferenceUsageEvents: {
          some: { billingStatus: "charged", createdAt: { gte: since } },
        },
      },
    },
  });

  const userIds = accounts.map((account) => account.userId);
  if (userIds.length === 0) {
    const { count: dropped } = await prisma.userOutreach.deleteMany({
      where: { campaign, scannedAt: { lt: startedAt }, status: "todo" },
    });
    return { added: 0, dropped, scanned: 0 };
  }

  const [lastActive, ranOut, existing] = await Promise.all([
    prisma.inferenceUsageEvent.groupBy({
      _max: { createdAt: true },
      by: ["userId"],
      where: { billingStatus: "charged", userId: { in: userIds } },
    }),
    // The moment the balance last hit zero. Absent for an account still in
    // credit, which is exactly what the list wants to show.
    prisma.userCreditLedgerEntry.groupBy({
      _max: { createdAt: true },
      by: ["userId"],
      where: { balanceAfterMicros: zeroCreditMicros, userId: { in: userIds } },
    }),
    prisma.userOutreach.findMany({
      select: { lastSentAt: true, status: true, userId: true },
      where: { campaign, userId: { in: userIds } },
    }),
  ]);

  const lastActiveBy = new Map(lastActive.map((row) => [row.userId, row._max.createdAt]));
  const ranOutBy = new Map(ranOut.map((row) => [row.userId, row._max.createdAt]));
  const existingBy = new Map(existing.map((row) => [row.userId, row]));

  const writes = accounts.map((account) => {
    const snapshot = {
      balanceMicros: account.balanceMicros,
      lastActiveAt: lastActiveBy.get(account.userId) ?? null,
      ranOutAt: ranOutBy.get(account.userId) ?? null,
      scannedAt: startedAt,
      spentMicros: account.lifetimeChargedMicros,
    };
    const prior = existingBy.get(account.userId);
    // A contacted row rests for OUTREACH_RECONTACT_DAYS, then comes back
    // around. Replied and ignored stay put until a person clears them.
    const revive =
      prior?.status === "sent" && (!prior.lastSentAt || prior.lastSentAt < recontactBefore);
    return prisma.userOutreach.upsert({
      create: { campaign, status: "todo", userId: account.userId, ...snapshot },
      update: revive ? { status: "todo", ...snapshot } : snapshot,
      where: { userId_campaign: { campaign, userId: account.userId } },
    });
  });

  for (let i = 0; i < writes.length; i += BATCH) {
    await prisma.$transaction(writes.slice(i, i + BATCH));
  }

  // Anything this run did not touch no longer qualifies — unsubscribed, went
  // Pro, or went cold. Only untouched candidates go; a contacted row is
  // history and stays.
  const { count: dropped } = await prisma.userOutreach.deleteMany({
    where: { campaign, scannedAt: { lt: startedAt }, status: "todo" },
  });

  return {
    added: accounts.length - existingBy.size,
    dropped,
    scanned: accounts.length,
  };
});
