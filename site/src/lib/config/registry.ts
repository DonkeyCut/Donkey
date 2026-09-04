import {
  DEFAULT_THRESHOLDS,
  defaultSettings as defaultsOf,
  defineSettings,
  publicSettingKeys,
  settingKeys,
  type PublicKeyOf,
  type PublicSettingsOf,
  type SettingsOf,
} from "@donkeycut/abexp";
import { z } from "zod";

// The settings registry: every runtime tunable the product has, declared once
// with a schema and a default. A value resolves default < override < variant
// (src/lib/config/resolve.ts); su edits the override, an experiment supplies
// the variant. Client-safe: zod only, so the su forms read the same
// declarations the server validates against. A feature that people might
// tune ships its setting here in the same change.

export const SETTINGS = defineSettings({
  experimentResults: {
    schema: z
      .object({
        // An ended experiment keeps getting a fresh read for this long, so
        // late conversions still land in it.
        graceDays: z.number().int().min(0).max(365),
        // The sample a positive result is believed on.
        minExposedPerVariant: z.number().int().min(1),
        minConversions: z.number().int().min(1),
        // The smaller sample a loss can be called on.
        earlyMinExposed: z.number().int().min(1),
        earlyMinConversions: z.number().int().min(1),
        shipPValue: z.number().min(0).max(1),
        stopProbability: z.number().min(0).max(1),
        // The lift the sample-size estimate plans for.
        plannedRelativeLift: z.number().min(0.01).max(10),
      })
      .strict(),
    default: {
      graceDays: 30,
      minExposedPerVariant: DEFAULT_THRESHOLDS.minExposedPerVariant,
      minConversions: DEFAULT_THRESHOLDS.minConversions,
      earlyMinExposed: DEFAULT_THRESHOLDS.earlyMinExposed,
      earlyMinConversions: DEFAULT_THRESHOLDS.earlyMinConversions,
      shipPValue: DEFAULT_THRESHOLDS.shipPValue,
      stopProbability: DEFAULT_THRESHOLDS.stopProbability,
      plannedRelativeLift: DEFAULT_THRESHOLDS.plannedRelativeLift,
    },
    public: false,
    title: "Experiment results",
    description:
      "The bars a verdict is called against, and how long an ended experiment keeps being recomputed.",
  },
});

export type SettingKey = keyof typeof SETTINGS;
export type Settings = SettingsOf<typeof SETTINGS>;
export type PublicSettingKey = PublicKeyOf<typeof SETTINGS>;
export type PublicSettings = PublicSettingsOf<typeof SETTINGS>;

export const SETTING_KEYS = settingKeys(SETTINGS);
export const PUBLIC_SETTING_KEYS = publicSettingKeys(SETTINGS);

export const isSettingKey = (key: string): key is SettingKey => key in SETTINGS;

export function defaultSettings(): Settings {
  return defaultsOf(SETTINGS);
}
