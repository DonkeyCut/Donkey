import { mock } from "bun:test";
import assert from "node:assert/strict";

import type { Prisma } from "@/generated/prisma/client";
import { DEFAULT_EMAIL_PRIORITIES } from "@/lib/email/kindIds";
import type { OutreachPayload } from "@/lib/marketing/send-outreach";

let optedOut = true;
let state = "queued";
const now = new Date();
const user = { id: "user", email: "reader@example.test", name: "Reader" };
const payload: OutreachPayload = {
  outreachId: "outreach", attempt: 1, actorUserId: "operator", subject: "Hello {{firstName}}",
  body: "A note", creditOffer: null, unsubscribeLink: false, trackReplies: false,
  vars: { balance: "0", email: user.email, firstName: user.name, name: user.name, spent: "0", storage: "0" },
};
const row = {
  id: "send", kind: "outreach", idempotencyKey: "outreach:outreach:1", payload, userId: user.id,
  promotionId: null, attempts: 0, error: null, priority: 80, rank: 0, notBefore: now, createdAt: now,
  updatedAt: now, sentAt: null, clickedAt: null,
};
const updates: Prisma.EmailSendUpdateManyArgs[] = [];
const send = mock(() => { throw new Error("Unexpected provider send"); });
const schedule = mock(() => { throw new Error("Unexpected retry job"); });
mock.module("@/lib/prisma", () => ({ prisma: {
  user: { findUnique: async () => user },
  userEmailSettings: { findUnique: async () => ({ marketingUnsubscribedAt: optedOut ? now : null }) },
  emailSend: {
    createMany: async () => ({ count: 1 }),
    findUniqueOrThrow: async () => ({ ...row, state }),
    findMany: async () => [],
    findFirst: async () => null,
    groupBy: async () => [],
    update: async ({ data }: { data: { state: string; error: unknown } }) => {
      state = data.state;
      assert.equal(data.error, null);
      return { ...row, state };
    },
    updateMany: async (args: Prisma.EmailSendUpdateManyArgs) => {
      updates.push(args);
      if (args.where?.user) {
        assert.equal(args.where.state, "failed");
        assert.deepEqual(args.where.user, { emailSettings: { marketingUnsubscribedAt: { not: null } } });
        assert.deepEqual(args.data, { error: null, state: "skipped" });
        assert.deepEqual(args.where.kind, { in: ["outreach", "promotion-hand", "outreach-test", "promotion"] });
        if (state !== "failed" || !optedOut) return { count: 0 };
        state = "skipped";
        return { count: 1 };
      }
      if (args.where?.state === "failed" && state !== "failed") return { count: 0 };
      return { count: 1 };
    },
  },
  promotion: { findMany: async () => [] },
  asyncJob: { findMany: async () => [] },
} }));
mock.module("@/lib/config/effective", () => ({ getGlobalSetting: async () => DEFAULT_EMAIL_PRIORITIES }));
mock.module("@/lib/email/resend", () => ({
  emailFrom: () => "Donkey <sender@example.test>",
  bulkFrom: () => "Donkey <sender@example.test>",
  isResendConfigured: () => true,
  getResend: () => ({ emails: { send } }),
  ResendNotConfiguredError: class extends Error {},
}));
mock.module("@/lib/email/send-budget", () => ({
  withEmailBudget: async (_kind: string, work: () => Promise<unknown>) => work(),
  emailBudgetStatus: async () => ({}),
  EmailBudgetError: class extends Error {},
}));
mock.module("@/lib/jobs/queue", () => ({ ensureJob: schedule }));

const { deliverEmail, drainOutbox, outboxOverview, retryEmail } = await import("@/lib/email/outbox");
const { buildOutreachEmail } = await import("@/lib/marketing/send-outreach");
assert.equal(await buildOutreachEmail(payload, user), null);
optedOut = false;
assert.equal((await buildOutreachEmail(payload, user))?.subject, "Hello Reader");
optedOut = true;
assert.deepEqual(await deliverEmail({ kind: "outreach", payload, idempotencyKey: row.idempotencyKey, userId: user.id }), {
  id: row.id, state: "skipped", error: null,
});
assert.equal(send.mock.calls.length, 0);

state = "failed";
assert.equal(await retryEmail(row.id), false);
assert.equal(updates.at(-2)?.where?.id, row.id);
assert.equal(state, "skipped");
assert.equal(schedule.mock.calls.length, 0);

state = "failed";
await outboxOverview();
assert.equal(state, "skipped");
state = "failed";
await drainOutbox(1000);
assert.equal(state, "skipped");

optedOut = false;
state = "failed";
await outboxOverview();
assert.equal(state, "failed");
