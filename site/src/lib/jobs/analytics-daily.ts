import { z } from "zod";

import { R2NotConfiguredError } from "@/cut/server/cloud/r2";
import { InvalidDayError, runAnalyticsDaily } from "@/lib/analytics/pipeline";
import { PosthogConfigError } from "@/lib/analytics/posthog";
import { StripeListTooLongError, StripeNotConfiguredError } from "@/lib/billing/stripe";
import { defineJob, JobFailure } from "@/lib/jobs/registry";

// The nightly analytics run, also retriggerable by hand. An empty payload is
// the regular run: yesterday plus any unfinished days in the window. A
// specific day re-runs just that day; force re-extracts even final files.
export const analyticsDailyJob = defineJob(
  z
    .object({
      day: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      force: z.boolean().optional(),
    })
    .strict(),
  async (payload) => {
    try {
      return await runAnalyticsDaily(payload);
    } catch (e) {
      // All of these are permanent: retrying an unconfigured store or Stripe,
      // a bad PostHog project id, an impossible day, or a Stripe list past
      // the cap can never succeed.
      if (
        e instanceof R2NotConfiguredError ||
        e instanceof InvalidDayError ||
        e instanceof PosthogConfigError ||
        e instanceof StripeNotConfiguredError ||
        e instanceof StripeListTooLongError
      ) {
        throw new JobFailure(e.message);
      }
      throw e;
    }
  },
);
