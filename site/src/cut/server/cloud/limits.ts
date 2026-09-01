import { getActiveProSubscription } from "@/lib/billing/pro-subscription";
import { isDonkeySuperUser } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

// Cut web mode's cost ceilings by account tier. Storage bounds R2; the daily
// render cap bounds worker CPU (exports + URL imports — hover previews are
// cheap and ride along uncounted). null = unlimited.
export type CutLimits = {
  storageBytes: number | null;
  renderJobsPerDay: number | null;
  /** Renders the user asked for that may be queued or running at once: the
   * worker pool is shared, so one account queueing by the dozen would hold
   * every other account's export behind it. */
  liveJobs: number | null;
  /** Chat turns in flight across the account's projects. */
  liveTurns: number | null;
  /** Clip titles a day — they are on the house. */
  titlesPerDay: number | null;
};

/** The kinds the daily cap counts: renders the user asked for. Hover proxies,
 * share cards, ladders and chat turns are bounded by the live cap instead. */
export const COUNTED_JOB_KINDS = ["export", "import_url", "convert"];

export const FREE_STORAGE_BYTES = 250 * 1024 ** 2;

/** Headroom an export may render into past the storage quota. A finished
 * export counts against storage like any other object, so a full account would
 * otherwise be unable to get its work out — the one thing it needs in order to
 * clear space. The margin keeps that door open without making exports free:
 * past it, and under the daily render cap either way, an export waits for space
 * or for Pro. */
export const EXPORT_QUOTA_MARGIN = 1.2;

const FREE: CutLimits = {
  storageBytes: FREE_STORAGE_BYTES,
  renderJobsPerDay: 10,
  liveJobs: 8,
  liveTurns: 4,
  titlesPerDay: 300,
};
const PRO: CutLimits = {
  storageBytes: 100 * 1024 ** 3,
  renderJobsPerDay: 200,
  liveJobs: 32,
  liveTurns: 8,
  titlesPerDay: 2000,
};
const UNLIMITED: CutLimits = {
  storageBytes: null,
  renderJobsPerDay: null,
  liveJobs: null,
  liveTurns: null,
  titlesPerDay: null,
};

/** The limits an account's tier earns. Super users are unlimited. */
export function cutLimitsForTier(tier: { superUser: boolean; pro: boolean }): CutLimits {
  if (tier.superUser) return UNLIMITED;
  return tier.pro ? PRO : FREE;
}

export async function cutLimitsFor(userId: string): Promise<CutLimits> {
  if (await isDonkeySuperUser(userId)) return UNLIMITED;
  return cutLimitsForTier({ superUser: false, pro: !!(await getActiveProSubscription(userId)) });
}

/** 429 when the account already has as many asked-for jobs in flight as its
 * tier allows, else null. The editor's own renders (proxy, card, ladder) are
 * held to one running and one queued per project instead, so background work
 * the user cannot see never refuses the export they asked for. */
export async function liveJobCheck(userId: string): Promise<Response | null> {
  const limits = await cutLimitsFor(userId);
  if (limits.liveJobs === null) return null;
  const live = await prisma.cutRenderJob.count({
    where: {
      userId,
      kind: { in: [...COUNTED_JOB_KINDS, "agent_turn"] },
      state: { in: ["queued", "running"] },
    },
  });
  if (live < limits.liveJobs) return null;
  return Response.json(
    {
      error: "Too many jobs are running on this account. Wait for one to finish.",
      code: "live_job_limit",
      limit: limits.liveJobs,
    },
    { status: 429 }
  );
}

/** 429 when another counted render job would break the daily cap or the live
 * cap, else null. The daily count reads every row of the day whatever its
 * state — a dismissed or canceled job was still a render this account asked
 * for — so nothing the user does to the dock changes the count. */
export async function renderJobCheck(userId: string): Promise<Response | null> {
  const live = await liveJobCheck(userId);
  if (live) return live;
  const limits = await cutLimitsFor(userId);
  if (limits.renderJobsPerDay === null) return null;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const used = await prisma.cutRenderJob.count({
    where: { userId, kind: { in: COUNTED_JOB_KINDS }, createdAt: { gte: since } },
  });
  if (used < limits.renderJobsPerDay) return null;
  // `error` is what the client's shared error paths render — keep it human.
  return Response.json(
    {
      error:
        "You've reached today's limit for exports, imports, and conversions. It resets over the next 24 hours — or Pro raises it.",
      code: "daily_render_limit",
      limit: limits.renderJobsPerDay,
    },
    { status: 429 }
  );
}
