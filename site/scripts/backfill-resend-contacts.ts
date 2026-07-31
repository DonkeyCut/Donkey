#!/usr/bin/env bun
/**
 * One-off: push every existing account into Resend as a contact (new signups
 * sync on creation). Accounts that already opted out are created unsubscribed.
 * Idempotent — an existing contact is left as-is — so the script can re-run.
 *
 * Run from site/ with production credentials in the environment:
 *   bun run scripts/backfill-resend-contacts.ts
 */

import { syncResendContact } from "../src/lib/email/sync-contact";
import { prisma } from "../src/lib/prisma";

const PAGE_SIZE = 100;

let synced = 0;
let failed = 0;
let cursor: string | undefined;

for (;;) {
  const users = await prisma.user.findMany({
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: { id: "asc" },
    select: {
      email: true,
      emailSettings: { select: { marketingUnsubscribedAt: true } },
      id: true,
      name: true,
    },
    take: PAGE_SIZE,
  });
  if (users.length === 0) break;
  cursor = users[users.length - 1].id;

  for (const user of users) {
    try {
      await syncResendContact(user, {
        unsubscribed: user.emailSettings?.marketingUnsubscribedAt != null,
      });
      synced += 1;
    } catch (error) {
      failed += 1;
      console.error("[backfill] contact sync failed", { error, userId: user.id });
    }
  }
  console.log(`[backfill] ${synced} synced, ${failed} failed…`);
}

console.log(`[backfill] done: ${synced} synced, ${failed} failed`);
await prisma.$disconnect();
