// Server-side access to the stored rollup. The su routes fold it into what a
// caller asked for — a summary, or one page of people — so the file itself
// never goes over the wire.
import { NextResponse } from "next/server";
import { z } from "zod";

import { R2NotConfiguredError, readObject } from "@/cut/server/cloud/r2";
import { analyticsRollupSchema, ROLLUP_KEY, type AnalyticsRollup } from "@/lib/analytics/schema";

/** The stored rollup, or null when the nightly job hasn't written one.
 *
 * Storage failures throw rather than reading as an absent rollup: a refused
 * bucket answered as "no data yet" tells a dashboard the job never ran, which
 * is a different problem with a different fix. */
export async function readRollup(): Promise<AnalyticsRollup | null> {
  const stored = await readObject(ROLLUP_KEY);
  if (!stored) return null;
  return analyticsRollupSchema.parse(JSON.parse(stored.bytes.toString("utf8")));
}

/** The answer when the nightly job has not written a rollup yet. The `error`
 * code is what a client keys its empty state on; a bare 404 from anywhere else
 * — a deploy without this route, a proxy — carries no such code and is a
 * failure, not an empty dashboard. */
export const noRollupResponse = () =>
  NextResponse.json(
    { error: "no-rollup", message: "The nightly analytics job hasn't written a rollup yet." },
    { status: 404 },
  );

/** A rollup that could not be read, in the caller's words. Storage that is
 * unconfigured or refusing is a 503; a stored rollup this build cannot parse
 * is a 500 naming the field. */
export function storageProblemResponse(error: unknown): NextResponse {
  if (error instanceof R2NotConfiguredError) {
    return NextResponse.json(
      { error: "storage-unconfigured", message: "Storage is not configured." },
      { status: 503 },
    );
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return NextResponse.json(
      {
        error: "rollup-unreadable",
        message: `The stored rollup isn't a shape this build reads: ${detail(error)}`,
      },
      { status: 500 },
    );
  }
  return NextResponse.json(
    { error: "storage-unreadable", message: `Storage refused the rollup read: ${detail(error)}` },
    { status: 503 },
  );
}

function detail(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    if (!issue) return "the shape moved";
    return `${issue.path.join(".") || "the rollup"} ${issue.message.toLowerCase()}`;
  }
  return error instanceof Error ? error.message : String(error);
}
