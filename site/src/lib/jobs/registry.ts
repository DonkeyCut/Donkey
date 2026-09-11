import type { z } from "zod";

import type { Prisma } from "@/generated/prisma/client";
import { analyticsDailyJob } from "@/lib/jobs/analytics-daily";
import { billingRefreshJob } from "@/lib/jobs/billing-refresh";
import { creditExpiryJob } from "@/lib/jobs/credit-expiry";
import { creditExpiryNoticeJob } from "@/lib/jobs/credit-expiry-notice";
import { deleteUserJob } from "@/lib/jobs/delete-user";
import { experimentResultsJob } from "@/lib/jobs/experiment-results";
import { outreachScanJob } from "@/lib/jobs/outreach-scan";
import { emailDrainJob } from "@/lib/jobs/email-drain";
import { promotionQueueJob } from "@/lib/jobs/promotion-queue";

// Thrown by an executor when the job can never succeed — the message lands on
// the job row as its error. Anything else thrown is transient: the claim is
// released and the queue redelivers.
export class JobFailure extends Error {}

export class JobDeferred extends Error {
  public constructor(
    message: string,
    public readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = "JobDeferred";
  }
}

export type JobKind = {
  // Validates a payload at creation time and again at execution time; a stored
  // payload that no longer parses is a permanent failure.
  payload: z.ZodType<unknown>;
  run: (payload: unknown) => Promise<Prisma.InputJsonValue>;
};

export function defineJob<S extends z.ZodType<unknown>>(
  payload: S,
  run: (payload: z.output<S>) => Promise<Prisma.InputJsonValue>,
): JobKind {
  return { payload, run: (raw) => run(payload.parse(raw)) };
}

export const jobKinds: Record<string, JobKind> = {
  "analytics-daily": analyticsDailyJob,
  "billing-refresh": billingRefreshJob,
  "credit-expiry": creditExpiryJob,
  "credit-expiry-notice": creditExpiryNoticeJob,
  "delete-user": deleteUserJob,
  "email-drain": emailDrainJob,
  "experiment-results": experimentResultsJob,
  "outreach-scan": outreachScanJob,
  "promotion-queue": promotionQueueJob,
};
