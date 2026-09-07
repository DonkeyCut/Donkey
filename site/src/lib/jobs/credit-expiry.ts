import { z } from "zod";

import { expireAllCredits } from "@/lib/credits/inference";
import { defineJob } from "@/lib/jobs/registry";

// The nightly credit-expiry sweep. A grant past its expiry is normally settled
// the next time its account is read or charged; this settles the accounts
// nobody touched, so the stored balance the outreach scan reads is spendable
// money. Runs from /api/credits/expire. The result names how many accounts
// were settled, how many failed, and how many were left for the next run.
export const creditExpiryJob = defineJob(z.object({}).strict(), async () =>
  expireAllCredits(),
);
