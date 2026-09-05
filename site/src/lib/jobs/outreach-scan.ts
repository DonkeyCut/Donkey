import { z } from "zod";

import { cutLimitsForTier } from "@/cut/server/cloud/limits";
import {
  ACTIVE_PRO_STATUSES,
  isActiveProStatus,
  subscriptionIsPro,
} from "@/lib/billing/pro-subscription";
import {
  drainStripe,
  getStripe,
  stripeId,
  StripeListTooLongError,
  StripeNotConfiguredError,
} from "@/lib/billing/stripe";
import { creditStringToMicros, zeroCreditMicros } from "@/lib/credits/amounts";
import { defineJob, JobFailure } from "@/lib/jobs/registry";
import {
  CREDIT_SPENDERS_CAMPAIGN,
  OUTREACH_ACTIVE_WINDOW_DAYS,
  OUTREACH_MIN_SPENT_CREDITS,
  OUTREACH_MIN_STORAGE_BYTES,
  OUTREACH_PAYMENT_WINDOW_DAYS,
  OUTREACH_RECONTACT_DAYS,
  OUTREACH_STORAGE_FULL_SHARE,
  type OutreachReason,
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

// Rolls product usage and billing state into the outreach list. Runs nightly
// from /api/marketing/outreach/scan and by hand from the Outreach tab's Scan
// now button. Everything the Outreach tab shows is written here or read
// alongside it, so the page itself never touches the credit tables.
//
// Two kinds of people make the list. Free accounts using the product well —
// spending credits or holding media, and warm — are the ones worth a personal
// note. And anyone who hit a wall: ran out of credits, filled their storage,
// had a card declined, fell behind on Pro, or is leaving it. A wall counts
// however long ago the account was last seen, because that is when the
// person went quiet.
export const outreachScanJob = defineJob(z.object({}).strict(), async () => {
  try {
    return await scan();
  } catch (e) {
    // Permanent: an unconfigured Stripe or a list past the cap never clears
    // on retry.
    if (e instanceof StripeNotConfiguredError || e instanceof StripeListTooLongError) {
      throw new JobFailure(e.message);
    }
    throw e;
  }
});

async function scan() {
  const startedAt = new Date();
  const since = new Date(startedAt.getTime() - OUTREACH_ACTIVE_WINDOW_DAYS * DAY_MS);
  const paymentSince = new Date(startedAt.getTime() - OUTREACH_PAYMENT_WINDOW_DAYS * DAY_MS);
  const recontactBefore = new Date(startedAt.getTime() - OUTREACH_RECONTACT_DAYS * DAY_MS);
  const campaign = CREDIT_SPENDERS_CAMPAIGN;
  const minSpentMicros = creditStringToMicros(OUTREACH_MIN_SPENT_CREDITS);

  // An account that has not opted out of marketing. No settings row means it
  // never opted out.
  const marketable = {
    OR: [
      { emailSettings: { is: null } },
      { emailSettings: { is: { marketingUnsubscribedAt: null } } },
    ],
  };
  // A free account: a Pro subscriber already pays, so use alone is no reason.
  const free = {
    ...marketable,
    NOT: { proSubscription: { is: { status: { in: [...ACTIVE_PRO_STATUSES] } } } },
  };
  const freeStorageBytes = cutLimitsForTier({ pro: false, superUser: false }).storageBytes ?? 0;

  // Declined charges and ended subscriptions come from Stripe; the customer
  // id on each is the one stored on the user at their first checkout. The
  // pull runs alongside the database reads.
  const failedAtByCustomer = new Map<string, Date>();
  const endedCustomerIds = new Set<string>();
  const [spenders, storage] = await Promise.all([
    // Free accounts that spent a real share of their credits and are still
    // warm. The floor is on what went out.
    prisma.userCreditAccount.findMany({
      select: { userId: true },
      where: {
        lifetimeChargedMicros: { gte: minSpentMicros },
        user: {
          ...free,
          inferenceUsageEvents: {
            some: { billingStatus: "charged", createdAt: { gte: since } },
          },
        },
      },
    }),
    // Accounts holding a real amount of media. Uploading costs no credits, so
    // these people are invisible to the spend query. Starter media is
    // quotaExempt and never counted, so it names nobody. The storage counter
    // has no relation to the user, so opt-out, Pro and the tier's quota are
    // settled below.
    prisma.cutStorageUsage.findMany({
      select: { bytes: true, userId: true },
      where: {
        bytes: {
          gte:
            OUTREACH_MIN_STORAGE_BYTES <
            BigInt(Math.floor(freeStorageBytes * OUTREACH_STORAGE_FULL_SHARE))
              ? OUTREACH_MIN_STORAGE_BYTES
              : BigInt(Math.floor(freeStorageBytes * OUTREACH_STORAGE_FULL_SHARE)),
        },
      },
    }),
    (async () => {
      const stripe = getStripe();
      // A subscription that ended inside the payment window, by the date it
      // ended; the row in our database carries no end date of its own.
      for (const sub of await drainStripe(
        stripe.subscriptions.list({ limit: 100, status: "canceled" }),
      )) {
        const endedAt = sub.ended_at ?? sub.canceled_at;
        const customerId = stripeId(sub.customer);
        if (!subscriptionIsPro(sub)) continue;
        if (customerId && endedAt !== null && endedAt * 1000 >= paymentSince.getTime()) {
          endedCustomerIds.add(customerId);
        }
      }
      for (const charge of await drainStripe(
        stripe.charges.list({
          created: { gte: Math.floor(paymentSince.getTime() / 1000) },
          limit: 100,
        }),
      )) {
        const customerId = stripeId(charge.customer);
        if (charge.status !== "failed" || !customerId) continue;
        const at = new Date(charge.created * 1000);
        failedAtByCustomer.set(customerId, newest(at, failedAtByCustomer.get(customerId))!);
      }
    })(),
  ]);

  const retire = async () => {
    // Anything this run did not touch no longer qualifies — unsubscribed,
    // went cold, cleared the wall, or never came back. Only untouched
    // candidates go; a contacted row is history and stays.
    const { count } = await prisma.userOutreach.deleteMany({
      where: { campaign, scannedAt: { lt: startedAt }, status: "todo" },
    });
    return count;
  };

  const spenderIds = new Set(spenders.map((row) => row.userId));
  const heavyIds = new Set(
    storage.filter((row) => row.bytes >= OUTREACH_MIN_STORAGE_BYTES).map((row) => row.userId),
  );
  const stripeCustomerIds = [...new Set([...failedAtByCustomer.keys(), ...endedCustomerIds])];

  // One read names every candidate and carries what the reason pass needs:
  // the use-based ids from above, the walls found on the user's own rows —
  // credits used up, a Pro subscription behind or ending — and the Stripe
  // customers with a declined charge or an ended subscription. Opt-out comes
  // off here for all of them, so nothing further is read for an account
  // that can never be mailed.
  const users = await prisma.user.findMany({
    select: {
      creditAccount: { select: { balanceMicros: true, lifetimeChargedMicros: true } },
      id: true,
      proSubscription: { select: { cancelAtPeriodEnd: true, status: true } },
      stripeCustomerId: true,
      superUser: true,
    },
    where: {
      AND: [
        marketable,
        {
          OR: [
            { id: { in: [...new Set([...spenderIds, ...storage.map((row) => row.userId)])] } },
            {
              creditAccount: {
                is: {
                  balanceMicros: { lte: zeroCreditMicros },
                  lifetimeChargedMicros: { gte: minSpentMicros },
                },
              },
            },
            {
              proSubscription: {
                is: {
                  OR: [
                    { status: { in: ["past_due", "unpaid"] } },
                    { cancelAtPeriodEnd: true, status: { in: [...ACTIVE_PRO_STATUSES] } },
                  ],
                },
              },
            },
            ...(stripeCustomerIds.length > 0
              ? [{ stripeCustomerId: { in: stripeCustomerIds } }]
              : []),
          ],
        },
      ],
    },
  });
  const userIds = users.map((user) => user.id);
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

  const accounts = users.flatMap((user) => {
    const balanceMicros = user.creditAccount?.balanceMicros ?? zeroCreditMicros;
    const spentMicros = user.creditAccount?.lifetimeChargedMicros ?? zeroCreditMicros;
    const storageBytes = storedBy.get(user.id) ?? BigInt(0);
    const lastActiveAt = lastActiveBy.get(user.id) ?? null;
    const sub = user.proSubscription;
    const pro = sub !== null && isActiveProStatus(sub.status);
    const quota = cutLimitsForTier({ pro, superUser: user.superUser }).storageBytes;
    const paymentFailedAt = user.stripeCustomerId
      ? (failedAtByCustomer.get(user.stripeCustomerId) ?? null)
      : null;

    const reasons: OutreachReason[] = [];
    // Spenders billed a call inside the window, so they are warm by
    // construction. Holders have to be warm: something of theirs moved
    // inside the window.
    if (spenderIds.has(user.id)) reasons.push("spent");
    if (!pro && heavyIds.has(user.id) && lastActiveAt !== null && lastActiveAt >= since) {
      reasons.push("storage");
    }
    if (balanceMicros <= zeroCreditMicros && spentMicros >= minSpentMicros) {
      reasons.push("no_credits");
    }
    if (quota !== null && Number(storageBytes) >= quota * OUTREACH_STORAGE_FULL_SHARE) {
      reasons.push("storage_full");
    }
    if (paymentFailedAt) reasons.push("payment_failed");
    if (sub?.status === "past_due" || sub?.status === "unpaid") reasons.push("past_due");
    if (pro && sub.cancelAtPeriodEnd) reasons.push("canceling");
    // An ended subscription is a reason only while nothing replaced it.
    if (!pro && user.stripeCustomerId && endedCustomerIds.has(user.stripeCustomerId)) {
      reasons.push("canceled");
    }
    if (reasons.length === 0) return [];

    return [
      {
        snapshot: {
          balanceMicros,
          lastActiveAt,
          paymentFailedAt,
          ranOutAt: ranOutBy.get(user.id) ?? null,
          reasons,
          scannedAt: startedAt,
          spentMicros,
          storageBytes,
        },
        userId: user.id,
      },
    ];
  });

  const writes = accounts.map((account) => {
    const prior = existingBy.get(account.userId);
    // A contacted row rests for OUTREACH_RECONTACT_DAYS, then comes back
    // around. Replied and ignored stay put until a person clears them.
    const revive =
      prior?.status === "sent" && (!prior.lastSentAt || prior.lastSentAt < recontactBefore);
    return prisma.userOutreach.upsert({
      create: { campaign, status: "todo", userId: account.userId, ...account.snapshot },
      update: revive ? { status: "todo", ...account.snapshot } : account.snapshot,
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
}
