import type { Prisma } from "@/generated/prisma/client";
import { audienceSchema, EVERYONE, type Audience } from "@donkeycut/abexp";
import { metricSchema, variantSchema, type ExperimentMetric } from "@/lib/config/experiment";
import type { ExperimentResults } from "@donkeycut/abexp";
import { prisma } from "@/lib/prisma";

// The experiments list as su draws it: the definition, how many accounts each
// variant holds and how many were shown it, the rows written by hand, and
// the last computed results.

const summarySelect = {
  id: true,
  key: true,
  name: true,
  description: true,
  status: true,
  variants: true,
  audience: true,
  percent: true,
  metrics: true,
  results: true,
  resultsAt: true,
  startedAt: true,
  endedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ExperimentSelect;

type ExperimentRow = Prisma.ExperimentGetPayload<{ select: typeof summarySelect }>;

export type VariantStats = { key: string; assigned: number; exposed: number };

export type ManualAssignment = { userId: string; email: string; variant: string | null };

export async function experimentSummary(row: ExperimentRow) {
  // Counts come from the database, so an experiment with a hundred thousand
  // accounts costs the same as one with ten; only the rows written by hand
  // are listed, and there are never many.
  const [assigned, exposed, manual] = await Promise.all([
    prisma.experimentAssignment.groupBy({
      by: ["variant"],
      where: { experimentId: row.id, manual: false },
      _count: { _all: true },
    }),
    prisma.experimentAssignment.groupBy({
      by: ["variant"],
      where: { experimentId: row.id, manual: false, exposedAt: { not: null } },
      _count: { _all: true },
    }),
    prisma.experimentAssignment.findMany({
      where: { experimentId: row.id, manual: true },
      select: { userId: true, variant: true, user: { select: { email: true } } },
    }),
  ]);
  const countBy = (rows: { variant: string | null; _count: { _all: number } }[]) =>
    new Map(rows.map((r) => [r.variant, r._count._all]));
  const assignedBy = countBy(assigned);
  const exposedBy = countBy(exposed);
  const variants = variantSchema.array().safeParse(row.variants);
  const stats: VariantStats[] = (variants.success ? variants.data : []).map((variant) => ({
    key: variant.key,
    assigned: assignedBy.get(variant.key) ?? 0,
    exposed: exposedBy.get(variant.key) ?? 0,
  }));
  const overrides: ManualAssignment[] = manual.map((a) => ({
    userId: a.userId,
    email: a.user.email,
    variant: a.variant,
  }));
  const audience = audienceSchema.safeParse(row.audience);
  const metrics = metricSchema.array().safeParse(row.metrics);
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    status: row.status,
    variants: variants.success ? variants.data : [],
    audience: (audience.success ? audience.data : EVERYONE) as Audience,
    percent: row.percent,
    metrics: (metrics.success ? metrics.data : []) as ExperimentMetric[],
    results: (row.results as ExperimentResults | null) ?? null,
    resultsAt: row.resultsAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    stats,
    overrides,
  };
}


export type ExperimentSummary = Awaited<ReturnType<typeof experimentSummary>>;

export async function listExperiments() {
  const rows = await prisma.experiment.findMany({
    orderBy: [{ createdAt: "desc" }],
    select: summarySelect,
  });
  return Promise.all(rows.map(experimentSummary));
}

export async function findExperiment(id: string) {
  return prisma.experiment.findUnique({ where: { id }, select: summarySelect });
}

export type HoldoutRow = { userId: string; email: string; note: string | null; createdAt: string };

export async function listHoldout(): Promise<HoldoutRow[]> {
  const rows = await prisma.experimentHoldout.findMany({
    orderBy: { createdAt: "desc" },
    select: { userId: true, note: true, createdAt: true, user: { select: { email: true } } },
  });
  return rows.map((r) => ({
    userId: r.userId,
    email: r.user.email,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
  }));
}

export function invalidResponse(issues: { path: PropertyKey[]; message: string }[]) {
  return Response.json(
    {
      error: "Invalid request",
      issues: issues.map((issue) => ({ message: issue.message, path: issue.path.join(".") })),
    },
    { status: 400 },
  );
}
