import { NextRequest, NextResponse } from "next/server";

import { withSuperUser } from "@/lib/donkey-api-auth";
import { enqueueJob } from "@/lib/jobs/queue";

export const dynamic = "force-dynamic";
// Without a queue configured (local dev) the job runs inline before the
// response; give it room.
export const maxDuration = 300;

async function enqueueNightly(createdBy: string) {
  return NextResponse.json(await enqueueJob("analytics-daily", {}, createdBy));
}

const manual = withSuperUser((request) => enqueueNightly(request.donkey.userId));

// The nightly analytics run. Vercel's cron carries x-vercel-cron, which the
// platform strips from outside traffic; anyone else must be a signed-in super
// user. Per-day retriggers go through POST /api/jobs with {day, force}.
export const GET = (request: NextRequest) =>
  request.headers.get("x-vercel-cron") === "1"
    ? enqueueNightly("vercel-cron")
    : manual(request);
