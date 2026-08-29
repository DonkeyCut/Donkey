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

function newest(...dates: (Date | null | undefined)[]): Date | null {
  let best: Date | null = null;
  for (const date of dates) {
    if (date && (!best || date > best)) best = date;
  }
  return best;
}

// Rolls product usage into the outreach list. Runs nightly from
// /api/marketing/outreach/scan and by hand from the Outreach tab's Scan now
// button. Everything the Outreach tab shows is written here or read alongside
// it, so the page itself never touches the credit tables.
export const outreachScanJob = defineJob(z.object({}).strict(), async () => {
  const startedAt = new Date();
  const since = new Date(startedAt.getTime() - OUTREACH_ACTIVE_WINDOW_DAYS * DAY_MS);
  const recontactBefore = new Date(startedAt.getTime() - OUTREACH_RECONTACT_DAYS * DAY_MS);
  const campaign = CREDIT_SPENDERS_CAMPAIGN;

  // A free account that has not opted out of marketing.
  const marketable = {
    // An account with no settings row has never opted out.
    OR: [
      { emailSettings: { is: null } },
      { emailSettings: { is: { marketingUnsubscribedAt: null } } },
    ],
    NOT: {
      proSubscription: { is: { status: { in: [...ACTIVE_PRO_STATUSES] } } },
    },
  };

  const [spenders, uploaded, edited] = await Promise.all([
    // Accounts that have spent credits and are still warm. Any amount of spend
    // qualifies; what is left is a column on the row, not a filter.
    prisma.userCreditAccount.findMany({
      select: { balanceMicros: true, lifetimeChargedMicros: true, userId: true },
      where: {
        lifetimeChargedMicros: { gt: zeroCreditMicros },
        user: {
          ...marketable,
          inferenceUsageEvents: {
            some: { billingStatus: "charged", createdAt: { gte: since } },
          },
        },
      },
    }),
    // Media a person put in the cloud inside the window. Uploading costs no
    // credits, so these people are invisible to the spend query and are
    // exactly who this campaign would otherwise miss. Starter media is
    // quotaExempt and seeded by the signup, so it names nobody.
    prisma.cutMediaObject.groupBy({
      _max: { createdAt: true },
      by: ["userId"],
      where: {
        createdAt: { gte: since },
        quotaExempt: false,
        uploadState: "complete",
      },
    }),
    // Cloud projects edited inside the window.
    prisma.cutProject.groupBy({
      _max: { updatedAt: true },
      by: ["userId"],
      where: { updatedAt: { gte: since } },
    }),
  ]);

  // When each account last worked in the cloud by hand. Housekeeping writes
  // the storage counter on its own — GC sweeps, copy jobs, the render worker —
  // so its timestamp says nothing about a person being there; an upload and a
  // project edit are the ones they did themselves.
  const cloudActiveBy = new Map<string, Date>();
  for (const row of uploaded) {
    if (row._max.createdAt) cloudActiveBy.set(row.userId, row._max.createdAt);
  }
  for (const row of edited) {
    const at = newest(row._max.updatedAt, cloudActiveBy.get(row.userId));
    if (at) cloudActiveBy.set(row.userId, at);
  }

  const spenderIds = new Set(spenders.map((account) => account.userId));
  const cloudIds = [...cloudActiveBy.keys()].filter((userId) => !spenderIds.has(userId));
  // Opt-out and Pro come off first, so nothing further is read for an account
  // that can never be mailed. A credit account is provisioned at signup, so
  // the zero fallback is for a row that never landed.
  const cloudCandidates =
    cloudIds.length > 0
      ? await prisma.user.findMany({
          select: {
            creditAccount: { select: { balanceMicros: true, lifetimeChargedMicros: true } },
            id: true,
          },
          where: { ...marketable, id: { in: cloudIds } },
        })
      : [];
  // Working in the cloud is not the same as keeping anything there; the list
  // wants the people holding media.
  const holding =
    cloudCandidates.length > 0
      ? await prisma.cutStorageUsage.findMany({
          select: { userId: true },
          where: {
            bytes: { gt: BigInt(0) },
            userId: { in: cloudCandidates.map((user) => user.id) },
          },
        })
      : [];
  const holdingIds = new Set(holding.map((row) => row.userId));

  const accounts = [
    ...spenders,
    ...cloudCandidates
      .filter((user) => holdingIds.has(user.id))
      .map((user) => ({
        balanceMicros: user.creditAccount?.balanceMicros ?? zeroCreditMicros,
        lifetimeChargedMicros: user.creditAccount?.lifetimeChargedMicros ?? zeroCreditMicros,
        userId: user.id,
      })),
  ];
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
      // Model work and cloud editing are both use of the product, so either
      // one keeps an account looking as recent as it is.
      lastActiveAt: newest(
        lastActiveBy.get(account.userId),
        cloudActiveBy.get(account.userId),
      ),
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
