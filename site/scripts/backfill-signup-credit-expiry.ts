#!/usr/bin/env bun
/**
 * One-off: stamp an expiry on the signup grants made before signup credits
 * had one. Only signup grants that are still active, still hold credit, and
 * carry no expiry are touched; purchased, manual and Pro grants are left
 * alone. The lifetime comes from the signupCredits setting and counts from
 * the run, so every account gets the full window from today. The nightly
 * sweep then expires them when the day comes. Idempotent: a stamped grant no
 * longer matches.
 *
 * Run from site/ with production credentials in the environment:
 *   bun run scripts/backfill-signup-credit-expiry.ts          # dry run
 *   bun run scripts/backfill-signup-credit-expiry.ts --apply
 */

import { getGlobalSetting } from "../src/lib/config/effective";
import { zeroCreditMicros } from "../src/lib/credits/amounts";
import { creditGrantExpiry } from "../src/lib/credits/top-up";
import { prisma } from "../src/lib/prisma";

const apply = process.argv.includes("--apply");

const setting = await getGlobalSetting("signupCredits");
const expiresAt = creditGrantExpiry(setting.expiresAfterDays);
if (!expiresAt) {
  console.error("signupCredits grants never expire; set a lifetime on su first");
  process.exit(1);
}

const where = {
  expiresAt: null,
  remainingAmountMicros: { gt: zeroCreditMicros },
  source: "signup",
  status: "active",
};
const grants = await prisma.userCreditGrant.findMany({
  select: { id: true, remainingAmountMicros: true, userId: true },
  where,
});
const remaining = grants.reduce((sum, g) => sum + g.remainingAmountMicros, zeroCreditMicros);
console.log(
  `${grants.length} signup grants without an expiry, ${remaining} micros outstanding; ` +
    `expiry ${expiresAt.toISOString()} (${setting.expiresAfterDays} days)`,
);

if (apply) {
  const result = await prisma.userCreditGrant.updateMany({
    data: { expiresAt },
    where: { ...where, id: { in: grants.map((g) => g.id) } },
  });
  console.log(`stamped ${result.count} grants`);
} else {
  console.log("dry run; pass --apply to stamp them");
}

await prisma.$disconnect();
