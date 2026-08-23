import { describe, expect, test } from "bun:test";

import type { AnalyticsRollup } from "./schema";
import { summarizeRollup } from "./summary";

// Three days over two sources (one DB, one posthog); day two never got
// extracted. User A signed up before the window and works daily; user B signed
// up on day two and only opened the app on day three.
function rollup(billing?: AnalyticsRollup["billing"]): AnalyticsRollup {
  return {
    version: 1,
    generatedAt: "2026-08-21T04:00:00.000Z",
    days: ["2026-08-18", "2026-08-19", "2026-08-20"],
    sources: ["renders", "posthog"],
    missing: [{ day: "2026-08-19", sources: ["db", "posthog"] }],
    billing,
    users: [
      {
        id: "a",
        email: "a@example.com",
        name: "A",
        registeredAt: "2026-08-01T10:00:00.000Z",
        balanceMicros: "3000000",
        activity: [1, 0, 3],
      },
      {
        id: "b",
        email: "b@example.com",
        name: "B",
        registeredAt: "2026-08-19T12:00:00.000Z",
        balanceMicros: "500000",
        activity: [0, 0, 2],
      },
    ],
  };
}

describe("summarizeRollup", () => {
  test("counts actives and leaves an unextracted day unknown", () => {
    const summary = summarizeRollup(rollup());
    expect(summary.registered).toBe(2);
    expect(summary.points.map((p) => p.active)).toEqual([1, null, 2]);
    expect(summary.points.map((p) => p.working)).toEqual([1, null, 1]);
    expect(summary.missingDayCount).toBe(1);
    expect(summary.activeYesterday).toBe(2);
    expect(summary.active7d).toBe(2);
  });

  test("signups and totals carry the pre-window base", () => {
    const summary = summarizeRollup(rollup());
    expect(summary.points.map((p) => p.signups)).toEqual([0, 1, 0]);
    expect(summary.points.map((p) => p.totalRegistered)).toEqual([1, 2, 2]);
    expect(summary.signups7d).toBe(1);
    expect(summary.signupsWindow).toBe(1);
  });

  test("billing rides into revenue", () => {
    const summary = summarizeRollup(
      rollup({
        subscribers: 4,
        canceling: 1,
        churned: 2,
        funded: 6,
        fundedMicros: "120000000",
        revenue: [
          { proMicros: "10000000", topupMicros: "0" },
          { proMicros: "0", topupMicros: "5000000" },
          { proMicros: "0", topupMicros: "0" },
        ],
      }),
    );
    expect(summary.subscribers).toBe(4);
    expect(summary.fundedDollars).toBe(120);
    expect(summary.revenueDollars).toBe(15);
    expect(summary.points[0].proDollars).toBe(10);
    expect(summary.points[1].topupDollars).toBe(5);
  });

  test("a billingless rollup leaves revenue unknown", () => {
    const summary = summarizeRollup(rollup());
    expect(summary.revenueDollars).toBe(null);
    expect(summary.subscribers).toBe(null);
  });

  test("the summary carries no account rows", () => {
    expect(JSON.stringify(summarizeRollup(rollup()))).not.toContain("@example.com");
  });
});
