import { getActiveProSubscription } from "@/lib/billing/pro-subscription";
import { isDonkeySuperUser } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

// Cut web mode's cost ceilings by account tier. Storage bounds R2; the daily
// render cap bounds worker CPU (exports + URL imports — hover previews are
// cheap and ride along uncounted). null = unlimited.
export type CutLimits = {
  storageBytes: number | null;
  renderJobsPerDay: number | null;
};

export const FREE_STORAGE_BYTES = 250 * 1024 ** 2;

/** Headroom an export may render into past the storage quota. A finished
 * export counts against storage like any other object, so a full account would
 * otherwise be unable to get its work out — the one thing it needs in order to
 * clear space. The margin keeps that door open without making exports free:
 * past it, and under the daily render cap either way, an export waits for space
 * or for Pro. */
export const EXPORT_QUOTA_MARGIN = 1.2;

const FREE: CutLimits = { storageBytes: FREE_STORAGE_BYTES, renderJobsPerDay: 10 };
const PRO: CutLimits = { storageBytes: 100 * 1024 ** 3, renderJobsPerDay: 200 };
const UNLIMITED: CutLimits = { storageBytes: null, renderJobsPerDay: null };

export async function cutLimitsFor(userId: string): Promise<CutLimits> {
  if (await isDonkeySuperUser(userId)) return UNLIMITED;
  return (await getActiveProSubscription(userId)) ? PRO : FREE;
}

/** 429 when another counted render job would break the daily cap, else null. */
export async function renderJobCheck(userId: string): Promise<Response | null> {
  const limits = await cutLimitsFor(userId);
  if (limits.renderJobsPerDay === null) return null;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const used = await prisma.cutRenderJob.count({
    where: { userId, kind: { in: ["export", "import_url"] }, createdAt: { gte: since } },
  });
  if (used < limits.renderJobsPerDay) return null;
  // `error` is what the client's shared error paths render — keep it human.
  return Response.json(
    {
      error:
        "You've reached today's limit for exports and imports. It resets over the next 24 hours — or Pro raises it.",
      code: "daily_render_limit",
      limit: limits.renderJobsPerDay,
    },
    { status: 429 }
  );
}
