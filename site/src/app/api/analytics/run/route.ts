import { NextRequest, NextResponse } from "next/server";

import { isVercelCron, notFoundResponse } from "@/lib/donkey-api-auth";
import { enqueueJob } from "@/lib/jobs/queue";

// Without a queue configured (local dev) the job runs inline before the
// response; give it room.
export const maxDuration = 300;

// The nightly analytics run. Vercel's cron authenticates with the CRON_SECRET
// bearer token; manual runs — the dashboard's Run button and per-day
// {day, force} retriggers — go through POST /api/jobs.
export const GET = async (request: NextRequest) => {
  if (!isVercelCron(request)) return notFoundResponse();
  return NextResponse.json(await enqueueJob("analytics-daily", {}, "vercel-cron"));
};
