import { NextRequest, NextResponse } from "next/server";

import { isVercelCron, notFoundResponse } from "@/lib/donkey-api-auth";
import { enqueueJob } from "@/lib/jobs/queue";

// Without a queue configured (local dev) the job runs inline before the
// response; give it room.
export const maxDuration = 300;

// The nightly results run for every live experiment. Vercel's cron
// authenticates with the CRON_SECRET bearer token; a run for one experiment
// starts from su through POST /api/jobs.
export const GET = async (request: NextRequest) => {
  if (!isVercelCron(request)) return notFoundResponse();
  return NextResponse.json(await enqueueJob("experiment-results", {}, "vercel-cron"));
};
