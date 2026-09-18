import { NextResponse } from "next/server";

import { noRollupResponse, readRollup, storageProblemResponse } from "@/lib/analytics/read";
import { summarizeRollup } from "@/lib/analytics/summarize";
import { withSuperUser } from "@/lib/donkey-api-auth";

// The nightly rollup folded to the numbers a dashboard draws: one point per
// day, the headline counts, and the billing and referral blocks. Tens of
// kilobytes whatever the account table does, and no account's email or credit
// balance rides along — people come from /api/analytics/users, a page at a
// time. Super users only, like everything under /api/analytics.
export const GET = withSuperUser(async () => {
  let rollup;
  try {
    rollup = await readRollup();
  } catch (e) {
    return storageProblemResponse(e);
  }
  if (!rollup) return noRollupResponse();
  return NextResponse.json(summarizeRollup(rollup), { headers: { "Cache-Control": "no-store" } });
});
