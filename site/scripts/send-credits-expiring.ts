#!/usr/bin/env bun
/**
 * Tells every account with unspent signup credits the day they expire. One
 * notice per grant: the send is recorded on the grant's metadata, so a re-run
 * only reaches accounts the last run missed. Accounts that unsubscribed from
 * product email are skipped.
 *
 * Run from site/ with production credentials in the environment:
 *   NODE_ENV=production bun run scripts/send-credits-expiring.ts               # dry run
 *   NODE_ENV=production bun run scripts/send-credits-expiring.ts --to me@x.com # one preview
 *   NODE_ENV=production bun run scripts/send-credits-expiring.ts --apply
 */

import { creditMicrosToString, zeroCreditMicros } from "../src/lib/credits/amounts";
import { sendCreditsExpiringEmail } from "../src/lib/email/send-credits-expiring";
import { isMarketingUnsubscribed } from "../src/lib/email/unsubscribe";
import { isJsonObject } from "../src/lib/inference/json";
import { prisma } from "../src/lib/prisma";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const previewTo = args[args.indexOf("--to") + 1];
const preview = args.includes("--to") ? previewTo : null;
if (args.includes("--to") && !preview) {
  console.error("--to needs an address");
  process.exit(1);
}

const now = new Date();
const grants = await prisma.userCreditGrant.findMany({
  orderBy: { createdAt: "asc" },
  select: {
    id: true,
    expiresAt: true,
    metadata: true,
    remainingAmountMicros: true,
    user: { select: { email: true, id: true, name: true } },
  },
  where: {
    expiresAt: { gt: now },
    remainingAmountMicros: { gt: zeroCreditMicros },
    source: "signup",
    status: "active",
  },
});
const pending = grants.filter(
  (g) => !(isJsonObject(g.metadata) && typeof g.metadata.expiryNoticeSentAt === "string"),
);
console.log(`${grants.length} live signup grants, ${pending.length} not yet notified`);

if (preview) {
  const sample = pending[0] ?? grants[0];
  if (!sample?.expiresAt) {
    console.error("nothing to preview");
    process.exit(1);
  }
  await sendCreditsExpiringEmail(
    { email: preview, id: sample.user.id, name: "Ada" },
    creditMicrosToString(sample.remainingAmountMicros),
    sample.expiresAt,
    // Every preview is its own send, whatever the copy did in between.
    `credits-expiring-preview:${preview}:${Date.now()}`,
  );
  console.log(`preview sent to ${preview}`);
} else if (apply) {
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const grant of pending) {
    if (!grant.expiresAt) continue;
    if (await isMarketingUnsubscribed(grant.user.id)) {
      skipped++;
      continue;
    }
    try {
      await sendCreditsExpiringEmail(
        grant.user,
        creditMicrosToString(grant.remainingAmountMicros),
        grant.expiresAt,
      );
      await prisma.userCreditGrant.update({
        data: {
          metadata: {
            ...(isJsonObject(grant.metadata) ? grant.metadata : {}),
            expiryNoticeSentAt: new Date().toISOString(),
          },
        },
        where: { id: grant.id },
      });
      sent++;
    } catch (error) {
      failed++;
      console.error(`${grant.user.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`sent ${sent}, skipped ${skipped} unsubscribed, failed ${failed}`);
} else {
  console.log("dry run; pass --to <address> for one preview, --apply to send to everyone");
}

await prisma.$disconnect();
