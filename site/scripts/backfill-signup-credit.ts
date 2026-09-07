#!/usr/bin/env bun
/**
 * One-off: re-grant the signup app credit to accounts whose provisioning lost
 * the write-conflict race at signup (P2034) before grantCredits retried on
 * conflict. Idempotent — grantCredits dedupes on (source, sourceId, userId) —
 * so re-running or listing an already-granted user is a no-op. The amount and
 * lifetime come from the signupCredits setting, as at signup.
 *
 * Run from site/ with production credentials in the environment:
 *   bun run scripts/backfill-signup-credit.ts <userId> [<userId> ...]
 */

import { getGlobalSetting } from "../src/lib/config/effective";
import { grantSignupAppCredits } from "../src/lib/onboarding/signup-grants";
import { prisma } from "../src/lib/prisma";

const userIds = process.argv.slice(2);
if (userIds.length === 0) {
  console.error("usage: bun run scripts/backfill-signup-credit.ts <userId> [<userId> ...]");
  process.exit(1);
}

const setting = await getGlobalSetting("signupCredits");
if (setting.dollars <= 0) {
  console.error("signupCredits grants nothing; set the amount on su first");
  process.exit(1);
}

for (const userId of userIds) {
  const grant = await grantSignupAppCredits(userId, String(setting.dollars), setting.expiresAfterDays);
  console.log(`${userId}: grant ${grant.id} (${grant.originalAmountMicros} micros)`);
}

await prisma.$disconnect();
