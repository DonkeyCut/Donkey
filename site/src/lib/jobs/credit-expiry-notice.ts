import { z } from "zod";

import { getGlobalSetting } from "@/lib/config/effective";
import { queueDueCreditExpiryNotices } from "@/lib/email/credit-expiry-notices";
import { drainAsJob } from "@/lib/jobs/email-drain";
import { defineJob } from "@/lib/jobs/registry";

// The daily credit-expiry notice. Every account holding signup or manually
// granted credit that expires within the creditExpiryNotice window is queued
// one email naming what is left and the day it goes, and the outbox is
// drained. Runs from /api/credits/expiry-notices.
export const creditExpiryNoticeJob = defineJob(z.object({}).strict(), async () => {
  const setting = await getGlobalSetting("creditExpiryNotice");
  const queued = await queueDueCreditExpiryNotices({ withinDays: setting.daysBefore });
  const drained = await drainAsJob();
  return { ...queued, drained };
});
