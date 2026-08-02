import { z } from "zod";

import { R2NotConfiguredError } from "@/cut/server/cloud/r2";
import { InvalidDayError, runAnalyticsDaily } from "@/lib/analytics/pipeline";
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
      // Both are permanent: retrying an unconfigured store or an impossible
      // day can never succeed.
      if (e instanceof R2NotConfiguredError || e instanceof InvalidDayError) {
        throw new JobFailure(e.message);
      }
      throw e;
    }
  },
);
