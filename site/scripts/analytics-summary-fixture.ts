// Rewrites the analytics fixtures the DonkeyKit tests decode — the summary and
// the first page of accounts. Run it after changing what either carries, then
// run the DonkeyKit tests.
//
//   npm run analytics:summary-fixture
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SUMMARY_FIXTURE_PATH,
  USERS_FIXTURE_PATH,
  summaryFixtureJson,
  usersFixtureJson,
} from "@/lib/analytics/summary-fixture";

const root = fileURLToPath(new URL("../..", import.meta.url));
for (const [relative, json] of [
  [SUMMARY_FIXTURE_PATH, await summaryFixtureJson()],
  [USERS_FIXTURE_PATH, await usersFixtureJson()],
] as const) {
  const path = resolve(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, json);
  console.log(`wrote ${path}`);
}
