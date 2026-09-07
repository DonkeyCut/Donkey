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

import { maxCreditGrantDollars, maxCreditGrantExpiryDays } from "@/lib/credits/top-up";

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
  signupCredits: {
    schema: z
      .object({
        // USD the signup hook grants a new account; 0 grants nothing.
        dollars: z.number().int().min(0).max(maxCreditGrantDollars),
        // Days the grant stays spendable; null keeps it forever.
        expiresAfterDays: z.number().int().min(1).max(maxCreditGrantExpiryDays).nullable(),
      })
      .strict(),
    default: { dollars: 0, expiresAfterDays: 7 },
    public: false,
    title: "Signup credits",
    description: "USD a new account is granted at signup, and how many days the grant lives.",
  },
  creditExpiryNotice: {
    schema: z
      .object({
        // How many days before a given grant expires its account is emailed.
        daysBefore: z.number().int().min(1).max(maxCreditGrantExpiryDays),
      })
      .strict(),
    default: { daysBefore: 3 },
    public: false,
    title: "Credit expiry notice",
    description: "How many days before signup or manually granted credits expire the account is emailed.",
  },
  subscribeBonus: {
    schema: z
      .object({
        // USD granted for subscribing to Pro while the offer is open; 0 makes
        // no offer.
        dollars: z.number().int().min(0).max(maxCreditGrantDollars),
        // Share of the signup grant spent before the offer opens.
        spentPercent: z.number().int().min(1).max(100),
        // Hours the offer stays open once the app has shown it.
        windowHours: z.number().int().min(1).max(24 * 30),
        // The last UTC day the bonus credit is spendable (YYYY-MM-DD); null
        // keeps it forever.
        creditsExpireOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").nullable(),
      })
      .strict(),
    default: { dollars: 0, spentPercent: 50, windowHours: 24, creditsExpireOn: null },
    public: true,
    title: "Subscribe bonus",
    description:
      "Credit offered to an account that has spent this share of its signup grant, for subscribing to Pro within the window. The credit is spendable through the last day.",
  },
});

// The settings su shows on its Product tab: what an account gets. The
// settings tab under Experiments still lists every key.
export const PRODUCT_SETTING_KEYS = ["signupCredits", "creditExpiryNotice", "subscribeBonus"] as const satisfies readonly SettingKey[];

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
