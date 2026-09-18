import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SUMMARY_FIXTURE_PATH,
  USERS_FIXTURE_PATH,
  buildRollupFixture,
  buildSummaryFixture,
  buildUsersFixture,
  summaryFixtureJson,
  usersFixtureJson,
} from "./summary-fixture";
import { analyticsRollupSchema } from "./schema";

describe("the phone's summary fixture", () => {
  test("is a rollup the dashboards read", async () => {
    const parsed = analyticsRollupSchema.parse(await buildRollupFixture());
    expect(parsed.days).toHaveLength(3);
    expect(parsed.billing?.days).toHaveLength(4);
    expect(parsed.missing).toEqual([{ day: "2026-08-31", sources: ["db", "posthog"] }]);
    expect(parsed.users.map((u) => u.id)).toEqual(["u_new", "u_pro", "u_su"]);
  });

  test("carries the folded numbers and no account rows", async () => {
    const summary = await buildSummaryFixture();
    expect(summary.series).toHaveLength(3);
    expect(summary.registered).toBe(3);
    expect(summary.series.map((point) => point.active)).toEqual([2, null, 3]);
    expect(summary.missing).toEqual(["2026-08-31"]);
    expect(Object.keys(summary)).not.toContain("users");
  });

  test("pages accounts the way both clients read them", async () => {
    const page = await buildUsersFixture();
    expect(page.users.map((user) => user.id)).toEqual(["u_pro", "u_new", "u_su"]);
    expect(page.total).toBe(3);
    expect(page.nextCursor).toBeNull();
    expect(page.sorts.map((sort) => sort.id)).toEqual(["active", "recent", "joined", "paid"]);
  });

  test("matches the copies checked in with the DonkeyKit tests", async () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const copies = [
      [SUMMARY_FIXTURE_PATH, await summaryFixtureJson()],
      [USERS_FIXTURE_PATH, await usersFixtureJson()],
    ] as const;
    for (const [path, current] of copies) {
      const checkedIn = readFileSync(resolve(here, "../../../..", path), "utf8");
      if (checkedIn !== current) {
        throw new Error(
          `${path} is behind the code. Run \`npm run analytics:summary-fixture\` in site/, then \`swift test\` in apps/ios/DonkeyKit so the phone's model still reads it.`,
        );
      }
      expect(checkedIn).toBe(current);
    }
  });
});
