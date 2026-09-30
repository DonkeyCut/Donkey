import { experimentSchemas } from "@donkeycut/abexp";

import { SETTINGS } from "@/lib/config/registry";

// The experiment schemas bound to this product's registry, so every writer and
// reader validates variant settings against the same declarations.

export {
  EXPERIMENT_STATUSES,
  METRIC_SOURCES,
  STATUS_TRANSITIONS,
  canTransition,
  metricSchema,
  removedAssignedVariants,
  statusSchema,
  type ExperimentInput,
  type ExperimentMetric,
  type ExperimentStatus,
  type ExperimentVariant,
} from "@donkeycut/abexp";

export const { variantSchema, experimentSchema } = experimentSchemas(SETTINGS);
