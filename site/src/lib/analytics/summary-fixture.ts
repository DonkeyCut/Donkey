// The fixtures the phone's model is tested against: the summary and the
// first page of accounts, folded out of the contract's rollup fixture by the
// same summarizeRollup and rankUsers the API answers with, so the JSON says
// exactly what /api/analytics/summary and /api/analytics/users serve.
//
// The rollup fixture (fixtures/analytics-rollup.json) is a byte-identical
// copy of the one the back office's rollup-fixture.test.ts builds with the
// buildRollup that writes production rollups. The folded copies live with the
// DonkeyKit tests; `npm run analytics:summary-fixture` rewrites them.
// summary-fixture.test.ts fails while they are behind this code, and the
// DonkeyKit tests decode them, so a change to the summary's shape reaches the
// phone in the same change.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { rankUsers, USER_SORTS, USERS_PAGE_SIZE, type AnalyticsUsersPage } from "./rank";
import { summarizeRollup, type AnalyticsSummary } from "./summarize";
import { analyticsRollupSchema, type AnalyticsRollup } from "./schema";

export const SUMMARY_FIXTURE_PATH =
  "apps/ios/DonkeyKit/Tests/DonkeyKitModelsTests/Fixtures/analytics-summary.json";
export const USERS_FIXTURE_PATH =
  "apps/ios/DonkeyKit/Tests/DonkeyKitModelsTests/Fixtures/analytics-users.json";

const ROLLUP_FIXTURE = new URL("./fixtures/analytics-rollup.json", import.meta.url);

export function readRollupFixture(): AnalyticsRollup {
  return analyticsRollupSchema.parse(JSON.parse(readFileSync(fileURLToPath(ROLLUP_FIXTURE), "utf8")));
}

export async function buildSummaryFixture(): Promise<AnalyticsSummary> {
  return summarizeRollup(readRollupFixture());
}

export async function summaryFixtureJson(): Promise<string> {
  return `${JSON.stringify(await buildSummaryFixture(), null, 2)}\n`;
}

/** The first page of accounts, exactly as the users route answers it. */
export async function buildUsersFixture(): Promise<AnalyticsUsersPage> {
  const rollup = readRollupFixture();
  const ranked = rankUsers(rollup, "active");
  const end = USERS_PAGE_SIZE;
  return {
    generatedAt: rollup.generatedAt,
    nextCursor: end >= ranked.length ? null : end,
    pageSize: USERS_PAGE_SIZE,
    sorts: USER_SORTS,
    total: ranked.length,
    users: ranked.slice(0, end),
  };
}

export async function usersFixtureJson(): Promise<string> {
  return `${JSON.stringify(await buildUsersFixture(), null, 2)}\n`;
}
