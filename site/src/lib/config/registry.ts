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
import { promotionOfferSchema } from "@/lib/marketing/promotionOfferInput";
import { DEFAULT_EMAIL_PRIORITIES, EMAIL_KIND_IDS } from "@/lib/email/kindIds";

import { maxCreditGrantDollars, maxCreditGrantExpiryDays } from "@/lib/credits/top-up";

// The settings registry: every runtime tunable the product has, declared once
// with a schema and a default. A value resolves default < override < variant
// (src/lib/config/resolve.ts); su edits the override, an experiment supplies
// the variant. Client-safe: zod only, so the su forms read the same
// declarations the server validates against. A feature that people might
// tune ships its setting here in the same change.

function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export const SETTINGS = defineSettings({
  promotionCreditOffer: {
    schema: promotionOfferSchema.extend({ minimumAccountAgeDays: z.number().int().min(1).max(36500) }).strict(),
    default: { dollars: 15, claimWindowDays: 3, expiresAfterDays: 28, minimumAccountAgeDays: 7 },
    public: false,
    title: "Promotion credit offer",
    description: "Default credit offer and minimum account age for new promotion drafts. Saved drafts keep their terms.",
  },
  chatRuntime: {
    schema: z.object({
      syncIntervalMs: z.number().int().min(1000).max(30000),
      sceneLeaseMs: z.number().int().min(15000).max(120000),
      journalBytes: z.number().int().min(1048576).max(33554432),
    }).strict(),
    default: { syncIntervalMs: 5000, sceneLeaseMs: 30000, journalBytes: 8388608 },
    public: true,
    title: "Chat continuity",
    description: "Project and conversation refresh cadence, scene ownership expiry, and saved engine transcript size.",
  },
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
  emailDailySend: {
    schema: z
      .object({
        // Emails the provider lets the account send per UTC day.
        providerLimit: z.number().int().min(1).max(100000),
        // Slots kept free for emails sent by hand while work hours remain in
        // the UTC day; released once the work day is over.
        manualReserve: z.number().int().min(0).max(100000),
        manualTimeZone: z.string().refine(validTimeZone, "Unknown IANA time zone"),
        // Work hours in that zone, start inclusive and end exclusive.
        manualStartHour: z.number().int().min(0).max(23),
        manualEndHour: z.number().int().min(1).max(24),
        manualWeekdaysOnly: z.boolean(),
        // Days of signup history the transactional forecast averages over.
        signupLookbackDays: z.number().int().min(1).max(90),
        // Slots kept free beyond the forecast for transactional email the
        // forecast cannot see, such as credit offers sent by hand.
        transactionalHeadroom: z.number().int().min(0).max(100000),
      })
      .strict()
      .refine((v) => v.manualStartHour < v.manualEndHour, { message: "Work hours must end after they start." })
      .refine((v) => v.manualReserve + v.transactionalHeadroom < v.providerLimit, {
        message: "The reserves must leave room for bulk sends.",
      }),
    default: {
      providerLimit: 99,
      manualReserve: 10,
      manualTimeZone: "Asia/Seoul",
      manualStartHour: 9,
      manualEndHour: 18,
      manualWeekdaysOnly: true,
      signupLookbackDays: 7,
      transactionalHeadroom: 5,
    },
    public: false,
    title: "Daily email sends",
    description:
      "The provider's daily send cap, the slots held for emails sent by hand during work hours, and how the transactional forecast that holds slots ahead of promotions is sized.",
  },
  emailPriorities: {
    schema: z
      .object(Object.fromEntries(EMAIL_KIND_IDS.map((id) => [id, z.number().int().min(0).max(1000)])))
      .strict(),
    default: { ...DEFAULT_EMAIL_PRIORITIES },
    public: false,
    title: "Email priorities",
    description: "The order the outbox sends in when the day's quota is short: higher goes first. A change applies to emails queued from then on.",
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
  manualCreditOffer: {
    schema: z
      .object({
        // Days the emailed claim link stays open after it is sent.
        claimWindowDays: z.number().int().min(1).max(365),
      })
      .strict(),
    default: { claimWindowDays: 3 },
    public: false,
    title: "Manual credit offer",
    description: "How many days the claim link in a credit offer email stays open.",
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
  proAllowancePromotion: {
    schema: z
      .object({
        // Multiplies the AI allowance a Pro billing period starts with; 1 is
        // the plain plan.
        multiplier: z.number().int().min(1).max(20),
        // The last UTC day a period may start on and still get the multiplier
        // (YYYY-MM-DD); null keeps it on for every period.
        lastDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").nullable(),
      })
      .strict(),
    default: { multiplier: 1, lastDay: null },
    public: true,
    title: "Pro allowance promotion",
    description:
      "Multiplies the AI allowance a Pro billing period starts with, for periods that start on or before the last day. Later periods start with the plain allowance.",
  },
});

// The settings su shows on its Product tab: what an account gets. The
// settings tab under Experiments still lists every key.
export const PRODUCT_SETTING_KEYS = ["signupCredits", "creditExpiryNotice", "manualCreditOffer", "promotionCreditOffer", "subscribeBonus", "proAllowancePromotion"] as const satisfies readonly SettingKey[];

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
