import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ROLLUP_FIXTURE_PATH, buildRollupFixture, rollupFixtureJson } from "./rollup-fixture";
import { analyticsRollupSchema } from "./schema";

describe("the phone's rollup fixture", () => {
  test("is a rollup the dashboards read", async () => {
    const parsed = analyticsRollupSchema.parse(await buildRollupFixture());
    expect(parsed.days).toHaveLength(3);
    expect(parsed.billing?.days).toHaveLength(4);
    expect(parsed.missing).toEqual([{ day: "2026-08-31", sources: ["db", "posthog"] }]);
    expect(parsed.users.map((u) => u.id)).toEqual(["u_new", "u_pro", "u_su"]);
  });

  test("matches the copy checked in with the DonkeyKit tests", async () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const checkedIn = readFileSync(resolve(here, "../../../..", ROLLUP_FIXTURE_PATH), "utf8");
    const current = await rollupFixtureJson();
    if (checkedIn !== current) {
      throw new Error(
        "The rollup's shape changed. Run `npm run analytics:rollup-fixture` in site/, then `swift test` in apps/ios/DonkeyKit so the phone's model still reads it.",
      );
    }
    expect(checkedIn).toBe(current);
  });
});
