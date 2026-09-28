#!/usr/bin/env bun
/**
 * One-off: fill cancelAt and endedAt on the Pro subscription rows synced
 * before those columns existed. Only rows with a cancel scheduled or an ended
 * status are read; each one's Stripe subscription is fetched by its stored id
 * and run through the same sync the webhook uses, so the row lands exactly
 * where the next webhook would put it. Idempotent: a synced row reads the same
 * on the next run.
 *
 * Run from site/ with production credentials in the environment, after the
 * columns are migrated:
 *   bun run scripts/backfill-pro-subscription-ends.ts          # dry run
 *   bun run scripts/backfill-pro-subscription-ends.ts --apply
 */

import {
  ACTIVE_PRO_STATUSES,
  subscriptionCancelAt,
  syncProSubscription,
} from "../src/lib/billing/pro-subscription";
import { getStripe, unixToDate } from "../src/lib/billing/stripe";
import { prisma } from "../src/lib/prisma";

const apply = process.argv.includes("--apply");

const rows = await prisma.proSubscription.findMany({
  select: {
    cancelAt: true,
    cancelAtPeriodEnd: true,
    endedAt: true,
    status: true,
    stripeSubscriptionId: true,
    userId: true,
  },
  where: {
    OR: [
      { cancelAtPeriodEnd: true },
      { cancelAt: { not: null } },
      { status: { notIn: [...ACTIVE_PRO_STATUSES] } },
    ],
    stripeSubscriptionId: { not: null },
  },
});
console.log(`${rows.length} rows with a scheduled cancel or an ended status`);

const iso = (date: Date | null) => date?.toISOString() ?? "null";
const stripe = getStripe();
let changed = 0;
for (const row of rows) {
  const subscription = await stripe.subscriptions.retrieve(row.stripeSubscriptionId!);
  const cancelAt = subscriptionCancelAt(subscription);
  const endedAt = unixToDate(subscription.ended_at);
  const same =
    row.status === subscription.status &&
    row.cancelAt?.getTime() === cancelAt?.getTime() &&
    row.endedAt?.getTime() === endedAt?.getTime();
  if (same) continue;
  changed += 1;
  console.log(
    `${row.userId} ${subscription.id}: status ${row.status} → ${subscription.status}, ` +
      `cancelAt ${iso(row.cancelAt)} → ${iso(cancelAt)}, endedAt ${iso(row.endedAt)} → ${iso(endedAt)}`,
  );
  if (apply) await syncProSubscription(subscription);
}

console.log(apply ? `synced ${changed} rows` : `dry run; pass --apply to sync ${changed} rows`);

await prisma.$disconnect();
