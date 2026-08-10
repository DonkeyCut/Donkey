#!/usr/bin/env bun
/**
 * One-off: re-grant the signup app credit to accounts whose provisioning lost
 * the write-conflict race at signup (P2034) before grantCredits retried on
 * conflict. Idempotent — grantCredits dedupes on (source, sourceId, userId) —
 * so re-running or listing an already-granted user is a no-op.
 *
 * Run from site/ with production credentials in the environment:
 *   bun run scripts/backfill-signup-credit.ts <userId> [<userId> ...]
 */

import { creditStringToMicros } from "../src/lib/credits/amounts";
import { grantCredits } from "../src/lib/credits/inference";
import { signupAppCredits } from "../src/lib/onboarding/sequence";
import { prisma } from "../src/lib/prisma";

const userIds = process.argv.slice(2);
if (userIds.length === 0) {
  console.error("usage: bun run scripts/backfill-signup-credit.ts <userId> [<userId> ...]");
  process.exit(1);
}

for (const userId of userIds) {
  const grant = await grantCredits({
    amountMicros: creditStringToMicros(signupAppCredits),
    description: "Signup bonus credits",
    source: "signup",
    sourceId: `signup-app-credit:${userId}`,
    userId,
  });
  console.log(`${userId}: grant ${grant.id} (${grant.originalAmountMicros} micros)`);
}

await prisma.$disconnect();
