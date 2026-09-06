import { describe, expect, test } from "bun:test";
import type Stripe from "stripe";

import { subscriptionCancelScheduled } from "../billing/pro-subscription";
import { buildBilling } from "./pipeline";
import type { AnalyticsStripeSnapshot } from "./schema";

const days = ["2026-09-01", "2026-09-02", "2026-09-03"];

const snapshot: AnalyticsStripeSnapshot = {
  abandonedCheckouts: [
    { customerId: "cus_a", day: "2026-09-02", email: "a@x.test", id: "cs_1", kind: "pro" },
    { customerId: "cus_b", day: "2026-08-01", email: "b@x.test", id: "cs_2", kind: "pro" },
  ],
  charges: [
    // Paid inside the window: one Pro, one top-up.
    { amountMicros: "20000000", customerId: "cus_p", day: "2026-09-01", email: "p@x.test", failure: null, id: "ch_1", kind: "pro", paymentIntentId: "pi_1", status: "paid", userId: "u_p" },
    { amountMicros: "5000000", customerId: "cus_t", day: "2026-09-03", email: "t@x.test", failure: null, id: "ch_2", kind: "topup", paymentIntentId: "pi_2", status: "paid", userId: "u_t" },
    // Paid before the window: funds all-time only.
    { amountMicros: "5000000", customerId: "cus_t", day: "2026-08-01", email: "t@x.test", failure: null, id: "ch_3", kind: "topup", paymentIntentId: "pi_3", status: "paid", userId: "u_t" },
    // Declined inside the window.
    { amountMicros: "20000000", customerId: "cus_d", day: "2026-09-02", email: "d@x.test", failure: "Your card has insufficient funds.", id: "ch_4", kind: "pro", paymentIntentId: "pi_4", status: "declined", userId: "u_d" },
  ],
  dashboardUrl: "https://dashboard.stripe.com",
  refunds: [{ amountMicros: "5000000", chargeId: "ch_2", day: "2026-09-03", id: "re_1" }],
  subscriptions: [
    // Live, and scheduled to end through the portal's cancel_at.
    { cancelAt: "2026-09-08T00:00:00.000Z", cancelScheduled: true, canceledAt: "2026-09-02T10:00:00.000Z", comment: "Export broke.", createdAt: "2026-08-09T00:00:00.000Z", customerId: "cus_p", email: "p@x.test", endedAt: null, feedback: "switched_service", id: "sub_1", status: "active", userId: "u_p" },
    // Live, staying.
    { cancelAt: null, cancelScheduled: false, canceledAt: null, comment: null, createdAt: "2026-09-01T00:00:00.000Z", customerId: "cus_q", email: "q@x.test", endedAt: null, feedback: null, id: "sub_2", status: "active", userId: "u_q" },
    // Ended before the window.
    { cancelAt: null, cancelScheduled: false, canceledAt: "2026-07-01T00:00:00.000Z", comment: null, createdAt: "2026-06-01T00:00:00.000Z", customerId: "cus_r", email: "r@x.test", endedAt: "2026-07-01T00:00:00.000Z", feedback: null, id: "sub_3", status: "canceled", userId: "u_r" },
  ],
};

describe("buildBilling", () => {
  const billing = buildBilling(snapshot, days);

  test("counts a portal-scheduled cancel as canceling", () => {
    expect(billing.days).toEqual(days);
    expect(billing.subscribers).toBe(2);
    expect(billing.canceling).toEqual([
      {
        comment: "Export broke.",
        customerId: "cus_p",
        email: "p@x.test",
        endsAt: "2026-09-08T00:00:00.000Z",
        feedback: "switched_service",
        requestedAt: "2026-09-02T10:00:00.000Z",
        subscriptionId: "sub_1",
      },
    ]);
    expect(billing.churned).toBe(1);
  });

  test("nets paid against refunds and keeps declines outside", () => {
    expect(billing.window).toEqual({
      abandonedCheckouts: 1,
      cancels: 1,
      declinedCustomers: 1,
      declinedMicros: "20000000",
      netMicros: "20000000",
      paidMicros: "25000000",
      refundedMicros: "5000000",
    });
    expect(billing.revenue).toEqual([
      { cancels: 0, declinedMicros: "0", otherMicros: "0", proMicros: "20000000", refundedMicros: "0", topupMicros: "0" },
      { cancels: 1, declinedMicros: "20000000", otherMicros: "0", proMicros: "0", refundedMicros: "0", topupMicros: "0" },
      { cancels: 0, declinedMicros: "0", otherMicros: "0", proMicros: "0", refundedMicros: "5000000", topupMicros: "5000000" },
    ]);
  });

  test("funds all time and lists the window's events newest first", () => {
    expect(billing.funded).toBe(2);
    expect(billing.fundedMicros).toBe("30000000");
    expect(billing.events.map((e) => [e.day, e.kind, e.objectId, e.detail])).toEqual([
      ["2026-09-02", "canceled", "sub_1", "switched_service · Export broke."],
      ["2026-09-02", "declined", "pi_4", "Your card has insufficient funds."],
    ]);
  });

  test("a cancel event says where the subscription stands", () => {
    const cancel = billing.events.find((e) => e.kind === "canceled");
    expect([cancel?.ended, cancel?.endsAt]).toEqual([false, "2026-09-08T00:00:00.000Z"]);
    const stopped = buildBilling(
      {
        ...snapshot,
        subscriptions: [
          { ...snapshot.subscriptions[2], canceledAt: "2026-09-01T00:00:00.000Z", endedAt: "2026-09-01T00:00:00.000Z" },
        ],
      },
      days,
    );
    const gone = stopped.events.find((e) => e.kind === "canceled");
    expect([gone?.ended, gone?.endsAt]).toEqual([true, "2026-09-01T00:00:00.000Z"]);
  });
});

describe("subscriptionCancelScheduled", () => {
  const sub = (fields: Partial<Stripe.Subscription>) =>
    ({ cancel_at: null, cancel_at_period_end: false, ...fields }) as Stripe.Subscription;

  test("reads either spelling of a scheduled end", () => {
    expect(subscriptionCancelScheduled(sub({}))).toBe(false);
    expect(subscriptionCancelScheduled(sub({ cancel_at_period_end: true }))).toBe(true);
    expect(subscriptionCancelScheduled(sub({ cancel_at: 1788966820 }))).toBe(true);
  });
});
