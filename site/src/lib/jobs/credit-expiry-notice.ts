import { z } from "zod";

import { getGlobalSetting } from "@/lib/config/effective";
import { sendDueCreditExpiryNotices } from "@/lib/email/credit-expiry-notices";
import { ResendNotConfiguredError } from "@/lib/email/resend";
import { defineJob, JobFailure } from "@/lib/jobs/registry";

// The daily credit-expiry notice. Every account holding signup or manually
// granted credit that expires within the creditExpiryNotice window gets one
// email naming what is left and the day it goes. Runs from
// /api/credits/expiry-notices.
export const creditExpiryNoticeJob = defineJob(z.object({}).strict(), async () => {
  const setting = await getGlobalSetting("creditExpiryNotice");
  try {
    return await sendDueCreditExpiryNotices({ withinDays: setting.daysBefore });
  } catch (e) {
    // Permanent: an unconfigured sender never clears on retry.
    if (e instanceof ResendNotConfiguredError) throw new JobFailure(e.message);
    throw e;
  }
});
