import { z } from "zod";

import type { Prisma } from "@/generated/prisma/client";
import { fetchConvertedAfter, isPosthogQueryConfigured } from "@/lib/analytics/posthog";
import { getGlobalSetting } from "@/lib/config/effective";
import { parseVariants } from "@/lib/config/effective";
import { metricSchema, type ExperimentMetric } from "@/lib/config/experiment";
import { PURCHASE_SOURCES } from "@/lib/config/purchases";
import { computeResults, type Thresholds, type VariantCount } from "@donkeycut/abexp";
import { defineJob, JobFailure } from "@/lib/jobs/registry";
import { prisma } from "@/lib/prisma";

// Computes each experiment's read and stores it on the row: for every metric,
// how many exposed accounts in each variant converted after their exposure,
// and the verdict that follows. Runs nightly for every experiment that is
// running, paused, or recently ended, and on demand from su for one.

type Exposure = { userId: string; variant: string; exposedAt: Date };

// Postgres binds every id in an IN list, so the accounts go in chunks.
const USER_CHUNK = 500;

/** The accounts that converted at or after their own exposure. A conversion
 * before an account was exposed is not this experiment's doing, and a later
 * one still counts — an account enrolled late has usually acted before. */
async function convertedUsers(metric: ExperimentMetric, exposures: Exposure[]): Promise<Set<string>> {
  if (exposures.length === 0) return new Set();
  if (metric.source === "event") {
    return fetchConvertedAfter(
      metric.event!,
      exposures.map((e) => ({ distinctId: e.userId, since: e.exposedAt })),
    );
  }
  const exposedAt = new Map(exposures.map((e) => [e.userId, e.exposedAt]));
  const converted = new Set<string>();
  const ids = [...exposedAt.keys()];
  for (let i = 0; i < ids.length; i += USER_CHUNK) {
    const chunk = ids.slice(i, i + USER_CHUNK);
    const grants = await prisma.userCreditGrant.findMany({
      where: { userId: { in: chunk }, source: { in: [...PURCHASE_SOURCES] } },
      select: { userId: true, createdAt: true },
    });
    for (const grant of grants) {
      const since = exposedAt.get(grant.userId);
      if (since && grant.createdAt.getTime() >= since.getTime()) converted.add(grant.userId);
    }
  }
  return converted;
}

export async function computeExperimentResults(experimentId: string): Promise<{ key: string; verdict: string }> {
  const bars = await getGlobalSetting("experimentResults");
  const experiment = await prisma.experiment.findUnique({
    where: { id: experimentId },
    select: { id: true, key: true, variants: true, metrics: true },
  });
  if (!experiment) throw new JobFailure(`Experiment ${experimentId} does not exist.`);
  const variants = parseVariants(experiment.variants);
  const control = variants[0]?.key;
  if (!control) throw new JobFailure(`Experiment ${experiment.key} has no variants.`);
  const metrics = metricSchema.array().safeParse(experiment.metrics);
  if (!metrics.success) throw new JobFailure(`Experiment ${experiment.key} has metrics that no longer parse.`);

  // Only what the hash assigned and the app showed counts; a row written from
  // su, a held-out account, and an unexposed assignment are left out.
  const [rows, holdouts] = await Promise.all([
    prisma.experimentAssignment.findMany({
      where: { experimentId, manual: false, variant: { not: null }, exposedAt: { not: null } },
      select: { userId: true, variant: true, exposedAt: true },
    }),
    prisma.experimentHoldout.findMany({ select: { userId: true } }),
  ]);
  const held = new Set(holdouts.map((h) => h.userId));
  const exposures: Exposure[] = rows
    .filter((r) => !held.has(r.userId))
    .map((r) => ({ userId: r.userId, variant: r.variant!, exposedAt: r.exposedAt! }));
  const notes: string[] = [];
  const measured: { metric: ExperimentMetric; counts: VariantCount[] }[] = [];
  for (const metric of metrics.data) {
    if (metric.source === "event" && !isPosthogQueryConfigured()) {
      notes.push(`${metric.name}: PostHog query access is not configured, so this event metric was skipped.`);
      continue;
    }
    const converted = await convertedUsers(metric, exposures);
    const counts: VariantCount[] = variants.map((v) => ({ key: v.key, exposed: 0, converted: 0 }));
    const byKey = new Map(counts.map((c) => [c.key, c]));
    for (const exposure of exposures) {
      const count = byKey.get(exposure.variant);
      if (!count) continue;
      count.exposed += 1;
      if (converted.has(exposure.userId)) count.converted += 1;
    }
    measured.push({ metric, counts });
  }

  const results = computeResults({
    computedAt: new Date(),
    control,
    metrics: measured,
    notes,
    thresholds: bars as Thresholds,
  });
  await prisma.experiment.update({
    where: { id: experimentId },
    data: { results: results as unknown as Prisma.InputJsonValue, resultsAt: new Date(results.computedAt) },
  });
  return { key: experiment.key, verdict: results.verdict.state };
}

export const experimentResultsJob = defineJob(
  z.object({ experimentId: z.string().min(1).optional() }).strict(),
  async (payload) => {
    if (payload.experimentId) {
      return { computed: [await computeExperimentResults(payload.experimentId)] };
    }
    const { graceDays } = await getGlobalSetting("experimentResults");
    const endedAfter = new Date(Date.now() - graceDays * 86_400_000);
    const rows = await prisma.experiment.findMany({
      where: {
        OR: [{ status: { in: ["running", "paused"] } }, { status: "ended", endedAt: { gte: endedAfter } }],
      },
      select: { id: true },
    });
    const computed = [];
    for (const row of rows) computed.push(await computeExperimentResults(row.id));
    return { computed };
  },
);
