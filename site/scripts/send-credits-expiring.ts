#!/usr/bin/env bun
/**
 * Runs the credit-expiry notice by hand. The daily job mails accounts whose
 * given credit expires inside the creditExpiryNotice window; this widens the
 * window for a one-off, and can send a single preview to an account's own
 * address. Each grant is noticed once whichever path sends, so a run here and
 * the job never double-mail.
 *
 * Run from site/ with production credentials in the environment:
 *   NODE_ENV=production bun run scripts/send-credits-expiring.ts                    # dry run
 *   NODE_ENV=production bun run scripts/send-credits-expiring.ts --to me@x.com      # one preview
 *   NODE_ENV=production bun run scripts/send-credits-expiring.ts --apply --within 30
 */

import { getGlobalSetting } from "../src/lib/config/effective";
import { creditMicrosToString, zeroCreditMicros } from "../src/lib/credits/amounts";
import {
  expiryNoticed,
  NOTICED_GRANT_SOURCES,
  sendDueCreditExpiryNotices,
} from "../src/lib/email/credit-expiry-notices";
import { sendCreditsExpiringEmail } from "../src/lib/email/send-credits-expiring";
import { prisma } from "../src/lib/prisma";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const preview = args.includes("--to") ? args[args.indexOf("--to") + 1] : null;
if (args.includes("--to") && !preview) {
  console.error("--to needs an address");
  process.exit(1);
}
const withinDays = args.includes("--within")
  ? Number(args[args.indexOf("--within") + 1])
  : (await getGlobalSetting("creditExpiryNotice")).daysBefore;
if (!Number.isInteger(withinDays) || withinDays < 1) {
  console.error("--within needs a whole number of days");
  process.exit(1);
}

const now = new Date();
const DAY_MS = 24 * 60 * 60 * 1000;
const grants = await prisma.userCreditGrant.findMany({
  orderBy: { expiresAt: "asc" },
  select: { expiresAt: true, metadata: true, remainingAmountMicros: true, userId: true },
  where: {
    expiresAt: { gt: now, lte: new Date(now.getTime() + withinDays * DAY_MS) },
    remainingAmountMicros: { gt: zeroCreditMicros },
    source: { in: [...NOTICED_GRANT_SOURCES] },
    status: "active",
  },
});
const pending = grants.filter((g) => !expiryNoticed(g.metadata));
console.log(
  `${grants.length} given grants expire within ${withinDays} days, ${pending.length} not yet notified`,
);

if (preview) {
  const sample = pending[0] ?? grants[0];
  if (!sample?.expiresAt) {
    console.error("nothing to preview");
    process.exit(1);
  }
  // The footer's unsubscribe link is the previewer's own, never a customer's.
  const previewer = await prisma.user.findUnique({ select: { id: true }, where: { email: preview } });
  if (!previewer) {
    console.error(`${preview} has no account; previews go to an account's address`);
    process.exit(1);
  }
  await sendCreditsExpiringEmail(
    { email: preview, id: previewer.id, name: "Ada" },
    creditMicrosToString(sample.remainingAmountMicros),
    sample.expiresAt,
    // Every preview is its own send, whatever the copy did in between.
    `credits-expiring-preview:${preview}:${Date.now()}`,
  );
  console.log(`preview sent to ${preview}`);
} else if (apply) {
  const result = await sendDueCreditExpiryNotices({ now, withinDays });
  console.log(`sent ${result.sent}, failed ${result.failed}`);
} else {
  console.log("dry run; pass --to <address> for one preview, --apply to send");
}

await prisma.$disconnect();
