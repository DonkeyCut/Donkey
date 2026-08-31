import { z } from "zod";

import { ACTIVE_PRO_STATUSES } from "@/lib/billing/pro-subscription";
import { creditStringToMicros, zeroCreditMicros } from "@/lib/credits/amounts";
import { defineJob } from "@/lib/jobs/registry";
import {
  CREDIT_SPENDERS_CAMPAIGN,
  OUTREACH_ACTIVE_WINDOW_DAYS,
  OUTREACH_MIN_SPENT_CREDITS,
  OUTREACH_MIN_STORAGE_BYTES,
  OUTREACH_RECONTACT_DAYS,
  OUTREACH_RETURN_DAYS,
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

type Candidate = {
  balanceMicros: bigint;
  lifetimeChargedMicros: bigint;
  signedUpAt: Date;
  userId: string;
};

// Rolls product usage into the outreach list. Runs nightly from
// /api/marketing/outreach/scan and by hand from the Outreach tab's Scan now
// button. Everything the Outreach tab shows is written here or read alongside
// it, so the page itself never touches the credit tables.
export const outreachScanJob = defineJob(z.object({}).strict(), async () => {
  const startedAt = new Date();
  const since = new Date(startedAt.getTime() - OUTREACH_ACTIVE_WINDOW_DAYS * DAY_MS);
  const recontactBefore = new Date(startedAt.getTime() - OUTREACH_RECONTACT_DAYS * DAY_MS);
  const campaign = CREDIT_SPENDERS_CAMPAIGN;
  const minSpentMicros = creditStringToMicros(OUTREACH_MIN_SPENT_CREDITS);

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

  const [spenderAccounts, heavy] = await Promise.all([
    // Accounts that have spent a real share of their credits and are still
    // warm. What is left is a column on the row; the floor is on what went out.
    prisma.userCreditAccount.findMany({
      select: {
        balanceMicros: true,
        lifetimeChargedMicros: true,
        user: { select: { createdAt: true } },
        userId: true,
      },
      where: {
        lifetimeChargedMicros: { gte: minSpentMicros },
        user: {
          ...marketable,
          inferenceUsageEvents: {
            some: { billingStatus: "charged", createdAt: { gte: since } },
          },
        },
      },
    }),
    // Accounts holding most of the free quota. Uploading costs no credits, so
    // these people are invisible to the spend query. Starter media is
    // quotaExempt and never counted, so it names nobody.
    prisma.cutStorageUsage.findMany({
      select: { userId: true },
      where: { bytes: { gte: OUTREACH_MIN_STORAGE_BYTES } },
    }),
  ]);
  const spenders: Candidate[] = spenderAccounts.map((account) => ({
    balanceMicros: account.balanceMicros,
    lifetimeChargedMicros: account.lifetimeChargedMicros,
    signedUpAt: account.user.createdAt,
    userId: account.userId,
  }));
  const spenderIds = new Set(spenders.map((account) => account.userId));
  const heavyIds = heavy.map((row) => row.userId).filter((userId) => !spenderIds.has(userId));
  // Opt-out and Pro come off first, so nothing further is read for an account
  // that can never be mailed. A credit account is provisioned at signup, so
  // the zero fallback is for a row that never landed.
  const holders: Candidate[] =
    heavyIds.length > 0
      ? (
          await prisma.user.findMany({
            select: {
              createdAt: true,
              creditAccount: { select: { balanceMicros: true, lifetimeChargedMicros: true } },
              id: true,
            },
            where: { ...marketable, id: { in: heavyIds } },
          })
        ).map((user) => ({
          balanceMicros: user.creditAccount?.balanceMicros ?? zeroCreditMicros,
          lifetimeChargedMicros: user.creditAccount?.lifetimeChargedMicros ?? zeroCreditMicros,
          signedUpAt: user.createdAt,
          userId: user.id,
        }))
      : [];

  const retire = async () => {
    // Anything this run did not touch no longer qualifies — unsubscribed, went
    // Pro, went cold, or never came back. Only untouched candidates go; a
    // contacted row is history and stays.
    const { count } = await prisma.userOutreach.deleteMany({
      where: { campaign, scannedAt: { lt: startedAt }, status: "todo" },
    });
    return count;
  };
  const userIds = [...spenders, ...holders].map((account) => account.userId);
  if (userIds.length === 0) {
    return { added: 0, dropped: await retire(), scanned: 0 };
  }

  const [billed, uploaded, edited, stored, ranOut, existing] = await Promise.all([
    prisma.inferenceUsageEvent.groupBy({
      _max: { createdAt: true },
      by: ["userId"],
      where: { billingStatus: "charged", userId: { in: userIds } },
    }),
    // Cloud work the person did by hand: media they put up and projects they
    // edited. Housekeeping writes the storage counter on its own — GC sweeps,
    // copy jobs, the render worker — so its timestamp says nothing about a
    // person being there.
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
    prisma.cutStorageUsage.findMany({
      select: { bytes: true, userId: true },
      where: { userId: { in: userIds } },
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

  // Model work and cloud editing are both use of the product, so either one
  // keeps an account looking as recent as it is.
  const lastActiveBy = new Map<string, Date>();
  const touch = (userId: string, at: Date | null) => {
    const best = newest(at, lastActiveBy.get(userId));
    if (best) lastActiveBy.set(userId, best);
  };
  for (const row of billed) touch(row.userId, row._max.createdAt);
  for (const row of uploaded) touch(row.userId, row._max.createdAt);
  for (const row of edited) touch(row.userId, row._max.updatedAt);
  const storedBy = new Map(stored.map((row) => [row.userId, row.bytes]));
  const ranOutBy = new Map(ranOut.map((row) => [row.userId, row._max.createdAt]));
  const existingBy = new Map(existing.map((row) => [row.userId, row]));

  // Spenders have to have come back: latest activity a clear day past signup.
  // One sitting on signup day is a look, and the row never lands.
  const returned = spenders.filter((account) => {
    const lastActiveAt = lastActiveBy.get(account.userId);
    return (
      lastActiveAt !== undefined &&
      lastActiveAt.getTime() - account.signedUpAt.getTime() >= OUTREACH_RETURN_DAYS * DAY_MS
    );
  });
  // Holders have to be warm: something of theirs moved inside the window.
  const warm = holders.filter((account) => {
    const lastActiveAt = lastActiveBy.get(account.userId);
    return lastActiveAt !== undefined && lastActiveAt >= since;
  });
  const accounts = [...returned, ...warm];

  const writes = accounts.map((account) => {
    const snapshot = {
      balanceMicros: account.balanceMicros,
      lastActiveAt: lastActiveBy.get(account.userId) ?? null,
      ranOutAt: ranOutBy.get(account.userId) ?? null,
      scannedAt: startedAt,
      spentMicros: account.lifetimeChargedMicros,
      storageBytes: storedBy.get(account.userId) ?? BigInt(0),
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

  return {
    added: accounts.filter((account) => !existingBy.has(account.userId)).length,
    dropped: await retire(),
    scanned: accounts.length,
  };
});
