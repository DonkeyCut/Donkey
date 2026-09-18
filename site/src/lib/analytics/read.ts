// Server-side access to the stored rollup. The su routes fold it into what a
// caller asked for — a summary, or one page of people — so the file itself
// never goes over the wire.
import { NextResponse } from "next/server";

import { getObject, R2NotConfiguredError } from "@/cut/server/cloud/r2";
import { analyticsRollupSchema, ROLLUP_KEY, type AnalyticsRollup } from "@/lib/analytics/schema";

/** The stored rollup, or null when the nightly job hasn't written one. */
export async function readRollup(): Promise<AnalyticsRollup | null> {
  const stored = await getObject(ROLLUP_KEY);
  if (!stored) return null;
  return analyticsRollupSchema.parse(JSON.parse(stored.bytes.toString("utf8")));
}

/** The answer when there is no rollup to read: a deploy without storage, or a
 * job that has not run yet. */
export const noRollupResponse = () =>
  NextResponse.json({ error: "No rollup yet." }, { status: 404 });

export function storageProblemResponse(error: unknown): NextResponse {
  if (error instanceof R2NotConfiguredError) {
    return NextResponse.json({ error: "Storage is not configured." }, { status: 503 });
  }
  throw error;
}
