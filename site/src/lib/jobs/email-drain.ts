import { z } from "zod";

import { EMAIL_KIND_IDS, type EmailKindId } from "@/lib/email/kindIds";
import { drainOutbox, type DrainResult } from "@/lib/email/outbox";
import { defineJob, JobDeferred } from "@/lib/jobs/registry";

// Under the worker's 300 s maxDuration, with room for the continuation's
// own writes.
const BUDGET_MS = 200_000;

/** Runs the drainer inside a job: a run that ran out of time queues its
 * continuation, and one that ran out of budget comes back when the budget is
 * expected to open. A run for one kind continues for that kind. */
export async function drainAsJob(kind?: EmailKindId): Promise<DrainResult> {
  const result = await drainOutbox(BUDGET_MS, kind);
  if (result.more) {
    const { enqueueJob } = await import("@/lib/jobs/queue");
    await enqueueJob("email-drain", kind ? { kind } : {}, "system");
    return result;
  }
  if (result.retryAfterSeconds !== null) {
    throw new JobDeferred("Email budget reached; the outbox resumes when it opens.", result.retryAfterSeconds);
  }
  return result;
}

export const emailDrainJob = defineJob(
  z.object({ kind: z.enum(EMAIL_KIND_IDS).optional() }).strict(),
  async ({ kind }) => drainAsJob(kind),
);
