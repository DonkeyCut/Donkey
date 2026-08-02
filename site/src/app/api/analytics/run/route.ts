import { NextRequest, NextResponse } from "next/server";

import { notFoundResponse } from "@/lib/donkey-api-auth";
import { enqueueJob } from "@/lib/jobs/queue";

export const dynamic = "force-dynamic";
// Without a queue configured (local dev) the job runs inline before the
// response; give it room.
export const maxDuration = 300;

// The nightly analytics run. Vercel's cron carries x-vercel-cron, which the
// platform strips from outside traffic; manual runs — the dashboard's Run
// button and per-day {day, force} retriggers — go through POST /api/jobs.
export const GET = async (request: NextRequest) => {
  if (request.headers.get("x-vercel-cron") !== "1") return notFoundResponse();
  return NextResponse.json(await enqueueJob("analytics-daily", {}, "vercel-cron"));
};
