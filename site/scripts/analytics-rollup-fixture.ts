// Rewrites the analytics rollup fixture the DonkeyKit tests decode. Run it
// after changing what the rollup carries, then run the DonkeyKit tests.
//
//   npm run analytics:rollup-fixture
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ROLLUP_FIXTURE_PATH, rollupFixtureJson } from "@/lib/analytics/rollup-fixture";

const path = resolve(fileURLToPath(new URL("../..", import.meta.url)), ROLLUP_FIXTURE_PATH);
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, await rollupFixtureJson());
console.log(`wrote ${path}`);
