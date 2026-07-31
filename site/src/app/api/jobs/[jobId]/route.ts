import { NextResponse } from "next/server";

import {
  isDonkeySuperUser,
  notFoundResponse,
  withDonkeyAuth,
} from "@/lib/donkey-api-auth";
import { jobStatusResponse } from "@/lib/jobs/queue";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ jobId: string }> };

// Poll one background job for its outcome.
export const GET = withDonkeyAuth(async (request, context: RouteContext) => {
  if (!(await isDonkeySuperUser(request.donkey.userId))) {
    return NextResponse.json(
      {
        error: "Forbidden",
        message: "Only super users can run jobs.",
      },
      { status: 403 },
    );
  }

  const { jobId } = await context.params;
  const job = await prisma.asyncJob.findUnique({ where: { id: jobId } });
  if (!job) return notFoundResponse();
  return jobStatusResponse(job);
});
