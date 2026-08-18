import { notFoundResponse, withSuperUser } from "@/lib/donkey-api-auth";
import { jobStatusResponse } from "@/lib/jobs/queue";
import { prisma } from "@/lib/prisma";

type RouteContext = { params: Promise<{ jobId: string }> };

// Poll one background job for its outcome.
export const GET = withSuperUser(async (request, context: RouteContext) => {
  const { jobId } = await context.params;
  const job = await prisma.asyncJob.findUnique({ where: { id: jobId } });
  if (!job) return notFoundResponse();
  return jobStatusResponse(job);
});
