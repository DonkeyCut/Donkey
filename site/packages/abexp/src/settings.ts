import type { z } from "zod";

// A settings registry: every runtime tunable a product has, declared once
// with a schema and a default. A value resolves default < override < variant;
// the host stores overrides and supplies variants. The registry itself is the
// host's; this module gives it shape and resolution.

export type SettingDef<S extends z.ZodType = z.ZodType> = {
  schema: S;
  default: z.output<S>;
  // A public setting reaches the client through the account's config read; a
  // server setting is read only by handlers, webhooks and jobs.
  public: boolean;
  title: string;
  description: string;
};

export type SettingsRegistry = Record<string, SettingDef>;

export type SettingKeyOf<T extends SettingsRegistry> = keyof T & string;
export type SettingsOf<T extends SettingsRegistry> = { [K in keyof T]: z.output<T[K]["schema"]> };
export type PublicKeyOf<T extends SettingsRegistry> = {
  [K in keyof T]: T[K]["public"] extends true ? K & string : never;
}[keyof T];
export type PublicSettingsOf<T extends SettingsRegistry> = Pick<SettingsOf<T>, PublicKeyOf<T>>;

// Parses every default against its schema at module load, so a registry that
// declares an impossible default fails the process at boot.
export function defineSettings<const T extends SettingsRegistry>(defs: T): T {
  for (const [key, def] of Object.entries(defs)) {
    const parsed = def.schema.safeParse(def.default);
    if (!parsed.success) {
      throw new Error(`Setting "${key}" has a default its schema rejects: ${parsed.error.message}`);
    }
  }
  return defs;
}

export function settingKeys<T extends SettingsRegistry>(registry: T): SettingKeyOf<T>[] {
  return Object.keys(registry) as SettingKeyOf<T>[];
}

export function publicSettingKeys<T extends SettingsRegistry>(registry: T): PublicKeyOf<T>[] {
  return settingKeys(registry).filter((key) => registry[key].public) as PublicKeyOf<T>[];
}

export function defaultSettings<T extends SettingsRegistry>(registry: T): SettingsOf<T> {
  const out: Record<string, unknown> = {};
  for (const key of settingKeys(registry)) out[key] = registry[key].default;
  return out as SettingsOf<T>;
}

export type Resolved<T extends SettingsRegistry> = {
  settings: SettingsOf<T>;
  invalid: { key: SettingKeyOf<T>; layer: "override" | "variant" }[];
};

/** Pure resolution: default < override < variant. An override or a variant
 * value that no longer parses is skipped and named, so a schema change never
 * takes the product down; the host shows the key as invalid so it can be
 * reset. */
export function resolveSettings<T extends SettingsRegistry>(
  registry: T,
  overrides: Record<string, unknown>,
  variantConfigs: Record<string, unknown>[],
): Resolved<T> {
  const settings: Record<string, unknown> = {};
  const invalid: Resolved<T>["invalid"] = [];
  for (const key of settingKeys(registry)) {
    const { schema } = registry[key];
    let value: unknown = registry[key].default;
    if (key in overrides) {
      const parsed = schema.safeParse(overrides[key]);
      if (parsed.success) value = parsed.data;
      else invalid.push({ key, layer: "override" });
    }
    for (const config of variantConfigs) {
      if (!(key in config)) continue;
      const parsed = schema.safeParse(config[key]);
      if (parsed.success) value = parsed.data;
      else invalid.push({ key, layer: "variant" });
    }
    settings[key] = value;
  }
  return { settings: settings as SettingsOf<T>, invalid };
}

export function publicSubset<T extends SettingsRegistry>(registry: T, settings: SettingsOf<T>): PublicSettingsOf<T> {
  const out: Record<string, unknown> = {};
  for (const key of publicSettingKeys(registry)) out[key] = settings[key];
  return out as PublicSettingsOf<T>;
}
