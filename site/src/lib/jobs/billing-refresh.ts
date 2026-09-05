import { z } from "zod";

import { R2NotConfiguredError } from "@/cut/server/cloud/r2";
import { refreshBilling } from "@/lib/analytics/pipeline";
import { StripeListTooLongError, StripeNotConfiguredError } from "@/lib/billing/stripe";
import { defineJob, JobFailure } from "@/lib/jobs/registry";

// Re-reads the Stripe record into the analytics snapshot and rewrites the
// rollup's billing section. Queued by the Stripe webhook on every billing
// event, so the dashboard's money and subscription figures follow Stripe as
// it happens; also retriggerable by hand.
export const billingRefreshJob = defineJob(z.object({}).strict(), async () => {
  try {
    return await refreshBilling();
  } catch (e) {
    if (
      e instanceof R2NotConfiguredError ||
      e instanceof StripeNotConfiguredError ||
      e instanceof StripeListTooLongError
    ) {
      throw new JobFailure(e.message);
    }
    throw e;
  }
});
