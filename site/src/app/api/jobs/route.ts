import { NextResponse } from "next/server";
import { z } from "zod";

import type { Prisma } from "@/generated/prisma/client";
import { withSuperUser } from "@/lib/donkey-api-auth";
import { enqueueJob, healJob } from "@/lib/jobs/queue";
import { jobKinds } from "@/lib/jobs/registry";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
// Without a queue configured (local dev) the job runs inline before the
// response; give it room.
export const maxDuration = 300;

// The most recent jobs, newest first, each self-healed on the way out so a
// lost message republishes and a crashed execution reads as an error rather
// than running forever.
export const GET = withSuperUser(async () => {
  const rows = await prisma.asyncJob.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  const jobs = await Promise.all(rows.map(healJob));
  return NextResponse.json({
    jobs: jobs.map((job) => ({
      id: job.id,
      kind: job.kind,
      state: job.state,
      payload: job.payload,
      result: job.result ?? undefined,
      error: job.error ?? undefined,
      createdAt: job.createdAt.toISOString(),
    })),
  });
});

const jobRequestSchema = z
  .object({
    kind: z.string().min(1),
    payload: z.unknown(),
  })
  .strict();

// Start a background job. The kind names an executor in the registry, and the
// payload must match that kind's schema. The caller polls /api/jobs/[jobId]
// for the outcome.
export const POST = withSuperUser(async (request) => {
  const parsed = jobRequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid request",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  const kind = jobKinds[parsed.data.kind];
  if (!kind) {
    return NextResponse.json(
      {
        error: "Invalid request",
        message: `Unknown job kind "${parsed.data.kind}".`,
      },
      { status: 400 },
    );
  }
  const payload = kind.payload.safeParse(parsed.data.payload);
  if (!payload.success) {
    return NextResponse.json(
      {
        error: "Invalid request",
        issues: payload.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  const { jobId } = await enqueueJob(
    parsed.data.kind,
    payload.data as Prisma.InputJsonValue,
    request.donkey.userId,
  );
  return NextResponse.json({ jobId });
});
