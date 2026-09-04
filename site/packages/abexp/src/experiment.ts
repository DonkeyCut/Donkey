import { z } from "zod";

import { audienceSchema } from "./audience";
import type { SettingsRegistry } from "./settings";

// The shape of an experiment as the host writes it and the assigner reads it.
// The schemas that check variant settings are built per registry, so a form
// and its route validate against the same declarations.

export const EXPERIMENT_STATUSES = ["draft", "running", "paused", "ended"] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

// Where an experiment can go from each status. Ended is final.
export const STATUS_TRANSITIONS: Record<ExperimentStatus, readonly ExperimentStatus[]> = {
  draft: ["running"],
  running: ["paused", "ended"],
  paused: ["running", "ended"],
  ended: [],
};

export const canTransition = (from: ExperimentStatus, to: ExperimentStatus) =>
  STATUS_TRANSITIONS[from].includes(to);

export const statusSchema = z.enum(EXPERIMENT_STATUSES);

const slug = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/, "Lower-case letters, digits and underscores only.");

const variantBase = z
  .object({
    key: slug,
    name: z.string().trim().min(1).max(80),
    weight: z.number().int().min(0).max(1000),
    // Full values, one per setting the variant changes, each parsed against
    // that setting's own schema.
    config: z.record(z.string(), z.unknown()),
  })
  .strict();

export type ExperimentVariant = z.output<typeof variantBase>;

// What the results job counts for each exposed account: an analytics event
// it fired after exposure, or a purchase the host recorded. The first metric
// of an experiment is the primary one and decides the verdict.
export const METRIC_SOURCES = ["event", "purchase"] as const;

export const metricSchema = z
  .object({
    key: slug,
    name: z.string().trim().min(1).max(80),
    source: z.enum(METRIC_SOURCES),
    // The event name; required for an event metric, absent otherwise.
    event: z.string().trim().min(1).max(200).nullable(),
  })
  .strict()
  .superRefine((metric, ctx) => {
    if (metric.source === "event" && !metric.event) {
      ctx.addIssue({ code: "custom", message: "An event metric names the event.", path: ["event"] });
    }
    if (metric.source === "purchase" && metric.event) {
      ctx.addIssue({ code: "custom", message: "A purchase metric names no event.", path: ["event"] });
    }
  });

export type ExperimentMetric = z.output<typeof metricSchema>;

const experimentBase = z
  .object({
    key: slug,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).nullable(),
    // The first variant is the control the others are measured against.
    variants: z.array(variantBase).min(1).max(20),
    audience: audienceSchema,
    percent: z.number().int().min(0).max(100),
    metrics: z.array(metricSchema).max(20),
  })
  .strict();

export type ExperimentInput = z.output<typeof experimentBase>;

function uniqueKeys(items: { key: string }[], ctx: z.RefinementCtx, path: string, what: string) {
  const keys = new Set<string>();
  items.forEach((item, i) => {
    if (keys.has(item.key)) {
      ctx.addIssue({ code: "custom", message: `${what} key "${item.key}" repeats.`, path: [path, i, "key"] });
    }
    keys.add(item.key);
  });
}

/** The variant and experiment schemas checked against one registry. */
export function experimentSchemas<T extends SettingsRegistry>(registry: T) {
  const variantSchema = variantBase.superRefine((variant, ctx) => {
    for (const [key, value] of Object.entries(variant.config)) {
      const def = Object.hasOwn(registry, key) ? registry[key] : undefined;
      if (!def) {
        ctx.addIssue({ code: "custom", message: `Unknown setting "${key}".`, path: ["config", key] });
        continue;
      }
      // A variant reaches the product through the account's own config read.
      // A setting only the server reads is resolved without a user, so a
      // variant over it would assign and expose while changing nothing;
      // those are set by an override.
      if (!def.public) {
        ctx.addIssue({
          code: "custom",
          message: `"${key}" is a server setting; change it with an override.`,
          path: ["config", key],
        });
        continue;
      }
      const parsed = def.schema.safeParse(value);
      if (!parsed.success) {
        ctx.addIssue({
          code: "custom",
          message: `Invalid value for "${key}": ${parsed.error.issues[0]?.message ?? "rejected"}`,
          path: ["config", key],
        });
      }
    }
  });

  const experimentSchema = experimentBase
    .extend({ variants: z.array(variantSchema).min(1).max(20) })
    .superRefine((experiment, ctx) => {
      uniqueKeys(experiment.variants, ctx, "variants", "Variant");
      uniqueKeys(experiment.metrics, ctx, "metrics", "Metric");
      if (experiment.variants.reduce((sum, v) => sum + v.weight, 0) <= 0) {
        ctx.addIssue({ code: "custom", message: "Variant weights must add up above zero.", path: ["variants"] });
      }
    });

  return { variantSchema, experimentSchema };
}

/** Variant keys that carry assignments cannot leave: an assigned user would
 * have nothing to read. Adding a variant is fine. */
export function removedAssignedVariants(next: ExperimentInput, assignedKeys: Iterable<string>): string[] {
  const keep = new Set(next.variants.map((v) => v.key));
  return [...new Set(assignedKeys)].filter((key) => !keep.has(key));
}
