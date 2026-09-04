import { createHash } from "node:crypto";

import { matchesAudience, type Audience, type AudienceFacts } from "./audience";
import type { ExperimentStatus, ExperimentVariant } from "./experiment";

// Deterministic assignment: a user lands in the same bucket on every request,
// on every server, with no coordination. Two salts keep the two decisions
// independent — raising the rollout percent only adds users, and the variant
// a user gets does not shift when the rollout moves.

export type AssignableExperiment = {
  key: string;
  status: string;
  variants: ExperimentVariant[];
  audience: Audience;
  percent: number;
};

export type AssignContext = {
  userId: string;
  facts: AudienceFacts;
  now: Date;
};

/** A stable point in [0, 1) for this user under this key and salt. */
export function bucket(key: string, userId: string, salt: "rollout" | "variant"): number {
  const digest = createHash("sha256").update(`${key}:${salt}:${userId}`).digest();
  return digest.readUInt32BE(0) / 2 ** 32;
}

export function isEligible(experiment: AssignableExperiment, ctx: AssignContext): boolean {
  if ((experiment.status as ExperimentStatus) !== "running") return false;
  if (!matchesAudience(experiment.audience, ctx.facts, ctx.now)) return false;
  return bucket(experiment.key, ctx.userId, "rollout") * 100 < experiment.percent;
}

/** The variant an eligible user draws, by weight. Null when no weight is set. */
export function pickVariant(experiment: AssignableExperiment, userId: string): string | null {
  const total = experiment.variants.reduce((sum, v) => sum + v.weight, 0);
  if (total <= 0) return null;
  const point = bucket(experiment.key, userId, "variant") * total;
  let edge = 0;
  for (const variant of experiment.variants) {
    edge += variant.weight;
    if (variant.weight > 0 && point < edge) return variant.key;
  }
  return experiment.variants.findLast((v) => v.weight > 0)?.key ?? null;
}
