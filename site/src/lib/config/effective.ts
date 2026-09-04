import type { Prisma } from "@/generated/prisma/client";
import { isEligible, pickVariant } from "@donkeycut/abexp";
import { audienceNeeds, audienceSchema, type Audience, type AudienceFact } from "@donkeycut/abexp";
import { collectFacts } from "@/lib/config/audienceFacts";
import { variantSchema, type ExperimentVariant } from "@/lib/config/experiment";
import type { SettingKey, Settings } from "@/lib/config/registry";
import { resolveSettings } from "@/lib/config/resolve";
import type { DonkeyAuthenticatedRequest } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

// What one user's configuration is right now: overrides from su, plus the
// variants of every running experiment they are assigned to. Assignment
// happens here, on first read, and sticks.

export type ConfigContext = {
  userId: string;
  country: string | null;
  createdAt: Date;
  // False for a caller with no account row (the dev bypass): settings still
  // resolve, experiments never assign.
  hasAccount: boolean;
};

export type Assignment = {
  experimentId: string;
  key: string;
  variant: string;
  exposedAt: Date | null;
};

export type EffectiveConfig = {
  settings: Settings;
  // experiment key → variant key, for every experiment applied.
  experiments: Record<string, string>;
  assignments: Assignment[];
  invalid: { key: SettingKey; layer: "override" | "variant" }[];
};

const COUNTRY_HEADER = "x-vercel-ip-country";

export function countryFromHeaders(headers: Headers): string | null {
  const raw = headers.get(COUNTRY_HEADER)?.trim().toUpperCase();
  return raw && /^[A-Z]{2}$/.test(raw) ? raw : null;
}

export async function contextFromRequest(request: DonkeyAuthenticatedRequest): Promise<ConfigContext> {
  const user = await prisma.user.findUnique({
    where: { id: request.donkey.userId },
    select: { createdAt: true },
  });
  return {
    userId: request.donkey.userId,
    country: countryFromHeaders(request.headers),
    createdAt: user?.createdAt ?? new Date(0),
    hasAccount: user !== null,
  };
}

export async function readOverrides(): Promise<Record<string, unknown>> {
  const rows = await prisma.settingOverride.findMany({ select: { key: true, value: true } });
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export function parseVariants(raw: Prisma.JsonValue): ExperimentVariant[] {
  const parsed = variantSchema.array().safeParse(raw);
  return parsed.success ? parsed.data : [];
}

/** An audience that no longer parses admits nobody. */
export function parseAudience(raw: Prisma.JsonValue): Audience | null {
  const parsed = audienceSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function getEffectiveConfig(ctx: ConfigContext): Promise<EffectiveConfig> {
  const [overrides, experiments, existing, holdout] = await Promise.all([
    readOverrides(),
    prisma.experiment.findMany({
      where: { status: { in: ["running", "paused"] } },
      // Fixed order, so two experiments that touch one setting resolve the
      // same way on every request: the one started later wins.
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, key: true, status: true, variants: true, audience: true, percent: true },
    }),
    ctx.hasAccount
      ? prisma.experimentAssignment.findMany({
          where: { userId: ctx.userId },
          select: { experimentId: true, variant: true, exposedAt: true },
        })
      : Promise.resolve([]),
    ctx.hasAccount
      ? prisma.experimentHoldout.findUnique({ where: { userId: ctx.userId }, select: { userId: true } })
      : Promise.resolve(null),
  ]);
  const heldOut = holdout !== null;

  const byExperiment = new Map(existing.map((a) => [a.experimentId, a]));
  const candidates = experiments
    .filter((e) => e.status === "running" && !byExperiment.has(e.id))
    .map((e) => ({ ...e, variants: parseVariants(e.variants), audience: parseAudience(e.audience) }))
    .filter((e): e is typeof e & { audience: Audience } => e.audience !== null);

  if (ctx.hasAccount && !heldOut && candidates.length > 0) {
    const needs = new Set<AudienceFact>();
    for (const e of candidates) for (const fact of audienceNeeds(e.audience)) needs.add(fact);
    const now = new Date();
    const facts = await collectFacts(ctx.userId, { country: ctx.country, createdAt: ctx.createdAt }, needs);
    const assign = { userId: ctx.userId, facts, now };
    const fresh: Prisma.ExperimentAssignmentCreateManyInput[] = [];
    for (const experiment of candidates) {
      if (!isEligible(experiment, assign)) continue;
      const variant = pickVariant(experiment, ctx.userId);
      if (!variant) continue;
      fresh.push({ experimentId: experiment.id, userId: ctx.userId, variant, country: ctx.country });
    }
    if (fresh.length > 0) {
      await prisma.experimentAssignment.createMany({ data: fresh, skipDuplicates: true });
      // Re-read so a concurrent first request's row wins over ours.
      const rows = await prisma.experimentAssignment.findMany({
        where: { userId: ctx.userId, experimentId: { in: fresh.map((f) => f.experimentId) } },
        select: { experimentId: true, variant: true, exposedAt: true },
      });
      for (const row of rows) byExperiment.set(row.experimentId, row);
    }
  }

  // A paused or ended experiment neither assigns nor applies; its rows stay so
  // a resume picks up where it left off. A held-out account and a row with no
  // variant read the plain configuration.
  const assignments: Assignment[] = [];
  const applied: Record<string, string> = {};
  const variantConfigs: Record<string, unknown>[] = [];
  // setting key → the experiment already varying it, to name a clash.
  const carriedBy = new Map<string, string>();
  for (const experiment of experiments) {
    const row = byExperiment.get(experiment.id);
    if (heldOut || !row || row.variant === null || experiment.status !== "running") continue;
    const variant = parseVariants(experiment.variants).find((v) => v.key === row.variant);
    if (!variant) continue;
    assignments.push({
      experimentId: experiment.id,
      key: experiment.key,
      variant: row.variant,
      exposedAt: row.exposedAt,
    });
    applied[experiment.key] = row.variant;
    for (const key of Object.keys(variant.config)) {
      const other = carriedBy.get(key);
      if (other) {
        console.error(
          `[config] experiments "${other}" and "${experiment.key}" both set "${key}"; the later one wins`,
        );
      }
      carriedBy.set(key, experiment.key);
    }
    variantConfigs.push(variant.config);
  }

  const resolved = resolveSettings(overrides, variantConfigs);
  for (const bad of resolved.invalid) {
    console.error(`[config] ${bad.layer} for setting "${bad.key}" no longer parses; skipped`);
  }
  return { settings: resolved.settings, experiments: applied, assignments, invalid: resolved.invalid };
}

/** One setting for a signed-in caller, experiments included. */
export async function getSetting<K extends SettingKey>(key: K, ctx: ConfigContext): Promise<Settings[K]> {
  const config = await getEffectiveConfig(ctx);
  return config.settings[key];
}

/** One setting with overrides only, for webhooks and jobs that act for no
 * particular caller. */
export async function getGlobalSetting<K extends SettingKey>(key: K): Promise<Settings[K]> {
  const resolved = resolveSettings(await readOverrides(), []);
  return resolved.settings[key];
}
