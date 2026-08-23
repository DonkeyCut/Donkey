import { NextResponse } from "next/server";

import { getObject, R2NotConfiguredError } from "@/cut/server/cloud/r2";
import { ROLLUP_KEY } from "@/lib/analytics/pipeline";
import { analyticsRollupSchema } from "@/lib/analytics/schema";
import { summarizeRollup } from "@/lib/analytics/summary";
import { withSuperUser } from "@/lib/donkey-api-auth";

// The nightly rollup reduced to its day series and headline numbers, for
// clients that draw the dashboard and nothing else. The reduction happens here
// because the rollup itself is one entry per registered account — emails,
// balances, and a 60-day activity mask — and grows with every signup, so a
// phone on cellular would be downloading the whole user table to render eight
// numbers. Same super-user gate as the rollup; the summary is derived from it.
export const GET = withSuperUser(async () => {
  let object;
  try {
    object = await getObject(ROLLUP_KEY);
  } catch (e) {
    if (e instanceof R2NotConfiguredError) {
      return NextResponse.json({ error: "Storage is not configured." }, { status: 503 });
    }
    throw e;
  }
  if (!object) return NextResponse.json({ error: "No rollup yet." }, { status: 404 });

  const parsed = analyticsRollupSchema.safeParse(
    JSON.parse(object.bytes.toString("utf8")) as unknown,
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "The stored rollup doesn't match the current schema." },
      { status: 500 },
    );
  }

  return NextResponse.json(summarizeRollup(parsed.data), {
    headers: { "Cache-Control": "no-store" },
  });
});
