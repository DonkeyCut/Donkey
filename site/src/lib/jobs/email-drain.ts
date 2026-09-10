import { z } from "zod";

import { drainOutbox, type DrainResult } from "@/lib/email/outbox";
import { defineJob, JobDeferred } from "@/lib/jobs/registry";

// Under the worker's 300 s maxDuration, with room for the continuation's
// own writes.
const BUDGET_MS = 200_000;

/** Runs the drainer inside a job: a run that ran out of time queues its
 * continuation, and one that ran out of quota comes back when the quota is
 * expected to open. */
export async function drainAsJob(): Promise<DrainResult> {
  const result = await drainOutbox(BUDGET_MS);
  if (result.more) {
    const { enqueueJob } = await import("@/lib/jobs/queue");
    await enqueueJob("email-drain", {}, "system");
    return result;
  }
  if (result.retryAfterSeconds !== null) {
    throw new JobDeferred("Daily email quota reached; the outbox resumes when it opens.", result.retryAfterSeconds);
  }
  return result;
}

export const emailDrainJob = defineJob(z.object({}).strict(), async () => drainAsJob());
