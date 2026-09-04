import {
  publicSubset as publicSubsetOf,
  resolveSettings as resolveOf,
  type Resolved as ResolvedOf,
} from "@donkeycut/abexp";

import { SETTINGS, type PublicSettings, type Settings } from "@/lib/config/registry";

// The package's resolution bound to this product's registry.

export type Resolved = ResolvedOf<typeof SETTINGS>;

export function resolveSettings(
  overrides: Record<string, unknown>,
  variantConfigs: Record<string, unknown>[],
): Resolved {
  return resolveOf(SETTINGS, overrides, variantConfigs);
}

export function publicSubset(settings: Settings): PublicSettings {
  return publicSubsetOf(SETTINGS, settings);
}
