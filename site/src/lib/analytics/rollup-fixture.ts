// The rollup the phone's model is tested against. It is the real consolidation
// (buildRollup) run over a small fixed record, so the JSON says exactly what
// the nightly job writes today.
//
// The checked-in copy lives with the DonkeyKit tests; `npm run
// analytics:rollup-fixture` rewrites it. rollup-fixture.test.ts fails while
// the copy is behind this code, and the DonkeyKit tests decode the copy, so a
// change to the rollup's shape reaches the phone in the same change.
import { buildRollup } from "./pipeline";
import type { AnalyticsRollup, AnalyticsSnapshotFile } from "./schema";
import type { AnalyticsDayFiles } from "./pipeline";

export const ROLLUP_FIXTURE_PATH =
  "apps/ios/DonkeyKit/Tests/DonkeyKitModelsTests/Fixtures/analytics-rollup.json";

// Three closed days of activity, and a billing window that runs one day
// further, to today: the two windows never line up by index.
const DAYS = ["2026-08-30", "2026-08-31", "2026-09-01"];
const BILLING_DAYS = [...DAYS, "2026-09-02"];

const snapshot: AnalyticsSnapshotFile = {
  balances: [
    { balanceMicros: "3000000", userId: "u_pro" },
    { balanceMicros: "500000", userId: "u_su" },
  ],
  generatedAt: "2026-09-02T04:00:00.000Z",
  storage: [{ bytes: "1048576", userId: "u_pro" }],
  stripe: {
    abandonedCheckouts: [
      { customerId: "cus_a", day: "2026-08-31", email: "a@x.test", id: "cs_1", kind: "pro" },
    ],
    charges: [
      { amountMicros: "20000000", customerId: "cus_p", day: "2026-08-30", email: "p@x.test", failure: null, id: "ch_1", kind: "pro", paymentIntentId: "pi_1", status: "paid", userId: "u_pro" },
      { amountMicros: "5000000", customerId: "cus_n", day: "2026-09-01", email: "n@x.test", failure: null, id: "ch_2", kind: "topup", paymentIntentId: "pi_2", status: "paid", userId: "u_new" },
      { amountMicros: "20000000", customerId: "cus_d", day: "2026-08-31", email: "d@x.test", failure: "Your card has insufficient funds.", id: "ch_3", kind: "pro", paymentIntentId: "pi_3", status: "declined", userId: null },
    ],
    dashboardUrl: "https://dashboard.stripe.com/test",
    refunds: [{ amountMicros: "1000000", chargeId: "ch_2", day: "2026-09-02", id: "re_1" }],
    subscriptions: [
      { cancelAt: "2026-09-08T00:00:00.000Z", cancelScheduled: true, canceledAt: "2026-08-31T10:00:00.000Z", comment: "Export broke.", createdAt: "2026-08-09T00:00:00.000Z", customerId: "cus_p", email: "p@x.test", feedback: "switched_service", id: "sub_1", status: "active", userId: "u_pro" },
      { cancelAt: null, cancelScheduled: false, canceledAt: null, comment: null, createdAt: "2026-07-01T00:00:00.000Z", customerId: "cus_s", email: "s@x.test", feedback: null, id: "sub_2", status: "active", userId: "u_su" },
      { cancelAt: null, cancelScheduled: false, canceledAt: "2026-07-15T00:00:00.000Z", comment: null, createdAt: "2026-06-01T00:00:00.000Z", customerId: "cus_r", email: "r@x.test", feedback: null, id: "sub_3", status: "canceled", userId: "u_gone" },
    ],
  },
  users: [
    { createdAt: "2026-08-01T10:00:00.000Z", email: "p@x.test", id: "u_pro", name: "Pro Person" },
    {
      createdAt: "2026-08-31T12:00:00.000Z",
      email: "n@x.test",
      id: "u_new",
      name: "New Person",
      referralAnsweredAt: "2026-08-31T12:05:00.000Z",
      referralOther: "a podcast",
      referralSources: ["youtube", "other"],
    },
    {
      createdAt: "2026-07-01T00:00:00.000Z",
      email: "s@x.test",
      id: "u_su",
      name: "Super Person",
      superUser: true,
    },
  ],
  version: 1,
};

const dayFiles = new Map<string, AnalyticsDayFiles>([
  [
    "2026-08-30",
    {
      db: { active: { inference: ["u_pro"], renders: ["u_su"] }, day: "2026-08-30", generatedAt: "2026-08-31T04:00:00.000Z", version: 1 },
      posthog: { activeDistinctIds: ["u_pro"], day: "2026-08-30", generatedAt: "2026-08-31T04:00:00.000Z", version: 1 },
    },
  ],
  // A night the extraction missed: both files absent.
  ["2026-08-31", { db: null, posthog: null }],
  [
    "2026-09-01",
    {
      db: { active: { renders: ["u_su"] }, day: "2026-09-01", generatedAt: "2026-09-02T04:00:00.000Z", version: 1 },
      // An anonymous pre-sign-in id rides along and drops out.
      posthog: { activeDistinctIds: ["u_pro", "u_new", "anon-7f3a"], day: "2026-09-01", generatedAt: "2026-09-02T04:00:00.000Z", version: 1 },
    },
  ],
]);

export function buildRollupFixture(): Promise<AnalyticsRollup> {
  return buildRollup({
    billingDays: BILLING_DAYS,
    days: DAYS,
    generatedAt: "2026-09-02T04:00:00.000Z",
    posthogConfigured: true,
    readDayFiles: async (day) => dayFiles.get(day) ?? { db: null, posthog: null },
    snapshot,
  });
}

export async function rollupFixtureJson(): Promise<string> {
  return `${JSON.stringify(await buildRollupFixture(), null, 2)}\n`;
}
