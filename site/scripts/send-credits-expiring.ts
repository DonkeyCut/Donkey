#!/usr/bin/env bun
/**
 * Runs the credit-expiry notice by hand. The daily job queues an email for
 * every account whose given credit expires inside the creditExpiryNotice
 * window and drains the outbox; this widens the window for a one-off, and
 * can send a single preview to an account's own address. Each grant is
 * queued once whichever path runs, so a run here and the job never
 * double-mail.
 *
 * Run from site/ with production credentials in the environment:
 *   NODE_ENV=production bun run scripts/send-credits-expiring.ts                    # dry run
 *   NODE_ENV=production bun run scripts/send-credits-expiring.ts --to me@x.com      # one preview
 *   NODE_ENV=production bun run scripts/send-credits-expiring.ts --apply --within 30
 */

import { getGlobalSetting } from "../src/lib/config/effective";
import { creditMicrosToString } from "../src/lib/credits/amounts";
import { pendingCreditExpiryGrants } from "../src/lib/email/credit-expiry-due";
import { queueDueCreditExpiryNotices } from "../src/lib/email/credit-expiry-notices";
import { withDailyEmailQuota } from "../src/lib/email/daily-send-limit";
import { drainOutbox } from "../src/lib/email/outbox";
import { getResend } from "../src/lib/email/resend";
import { buildCreditsExpiringEmail } from "../src/lib/email/send-credits-expiring";
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
const { due, pending } = await pendingCreditExpiryGrants(now, withinDays);
console.log(`${due} given grants expire within ${withinDays} days, ${pending.length} not yet notified`);

if (preview) {
  const sample = pending[0];
  if (!sample?.expiresAt) {
    console.error("nothing to preview");
    process.exit(1);
  }
  // The footer's unsubscribe link is the previewer's own, never a customer's.
  // A preview is a hand-sent email: it spends the manual quota and touches
  // no grant.
  const previewer = await prisma.user.findUnique({ select: { id: true }, where: { email: preview } });
  if (!previewer) {
    console.error(`${preview} has no account; previews go to an account's address`);
    process.exit(1);
  }
  const message = buildCreditsExpiringEmail(
    { email: preview, id: previewer.id, name: "Ada" },
    creditMicrosToString(sample.remainingAmountMicros),
    sample.expiresAt,
  );
  const result = await withDailyEmailQuota("manual", () =>
    // Every preview is its own send, whatever the copy did in between.
    getResend().emails.send(message, { idempotencyKey: `credits-expiring-preview:${preview}:${Date.now()}` }),
  );
  if (result?.error) throw new Error(`Resend send failed: ${result.error.name}: ${result.error.message}`);
  console.log(`preview sent to ${preview}`);
} else if (apply) {
  const queued = await queueDueCreditExpiryNotices({ now, withinDays });
  const drained = await drainOutbox(10 * 60_000);
  console.log(`queued ${queued.queued} new, sent ${drained.sent}, failed ${drained.failed}, skipped ${drained.skipped}`);
  if (drained.retryAfterSeconds !== null) {
    console.log(`the outbox comes back for the rest in ${Math.ceil(drained.retryAfterSeconds / 60)} min`);
  }
} else {
  console.log("dry run; pass --to <address> for one preview, --apply to send");
}

await prisma.$disconnect();
