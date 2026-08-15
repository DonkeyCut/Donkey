// The analytics data contract shared by the nightly pipeline, the superuser
// API, and the dashboard UI. The UI reads rollup.json only — never the
// database — so this file is the whole interface between them.
import { z } from "zod";

export const ANALYTICS_ROLLUP_VERSION = 1;

// Bit order for the per-day activity masks. Append-only: a new source takes
// the next bit so already-written rollups keep decoding.
export const ANALYTICS_DB_SOURCES = [
  "inference",
  "renders",
  "copies",
  "libraryAssets",
  "templates",
  "creditLedger",
] as const;
export const ANALYTICS_SOURCES = [...ANALYTICS_DB_SOURCES, "posthog"] as const;
export type AnalyticsDbSource = (typeof ANALYTICS_DB_SOURCES)[number];
export type AnalyticsSource = (typeof ANALYTICS_SOURCES)[number];

export const analyticsDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** UTC calendar day of a moment, as YYYY-MM-DD. */
export function utcDayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A day shifted by whole UTC days. Also normalizes: a string that is not a
 * real calendar day round-trips to a different string at delta 0. */
export function addUtcDays(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return utcDayOf(new Date(Date.UTC(y, (m ?? 1) - 1, (d ?? 1) + delta)));
}

const userIdList = z.array(z.string());

// Per-day extract of DB activity: which users each event table saw that day.
export const analyticsDbDayFileSchema = z.object({
  version: z.literal(1),
  day: analyticsDaySchema,
  generatedAt: z.string(),
  active: z.object({
    inference: userIdList.optional(),
    renders: userIdList.optional(),
    copies: userIdList.optional(),
    libraryAssets: userIdList.optional(),
    templates: userIdList.optional(),
    creditLedger: userIdList.optional(),
  }),
});
export type AnalyticsDbDayFile = z.infer<typeof analyticsDbDayFileSchema>;

export const analyticsPosthogDayFileSchema = z.object({
  version: z.literal(1),
  day: analyticsDaySchema,
  generatedAt: z.string(),
  // Raw distinct_ids. Anonymous pre-sign-in ids ride along and are dropped at
  // consolidation, so this list's length is not a user count.
  activeDistinctIds: userIdList,
});
export type AnalyticsPosthogDayFile = z.infer<typeof analyticsPosthogDayFileSchema>;

export const analyticsSnapshotFileSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  users: z.array(
    z.object({
      id: z.string(),
      email: z.string(),
      name: z.string(),
      createdAt: z.string(),
      // The onboarding referral answer; present once the user answered.
      referralAnsweredAt: z.string().optional(),
      referralSources: z.array(z.string()).optional(),
    }),
  ),
  balances: z.array(z.object({ userId: z.string(), balanceMicros: z.string() })),
  // Every Donkey Pro subscription row, whatever its Stripe status.
  subscriptions: z.array(
    z.object({
      userId: z.string(),
      status: z.string(),
      cancelAtPeriodEnd: z.boolean(),
    }),
  ),
  // One entry per paid Stripe credit grant — top-ups, auto-reloads, and Pro
  // monthly allowances. Each grant's amount equals the dollars charged, so
  // together they are the revenue record.
  payments: z.array(
    z.object({
      userId: z.string(),
      day: analyticsDaySchema,
      source: z.string(),
      amountMicros: z.string(),
    }),
  ),
});
export type AnalyticsSnapshotFile = z.infer<typeof analyticsSnapshotFileSchema>;

// The consolidated window the UI renders. Users come from the latest snapshot,
// so an account deleted since then carries no history here.
export const analyticsRollupSchema = z.object({
  version: z.literal(ANALYTICS_ROLLUP_VERSION),
  generatedAt: z.string(),
  // Oldest → newest; every user's activity array aligns with this.
  days: z.array(analyticsDaySchema),
  // Bit order of the activity masks (copy of ANALYTICS_SOURCES at write time).
  sources: z.array(z.string()),
  // Day files that were absent or unreadable at consolidation; the UI can gray
  // those columns out. Entries name the file kind: "db" or "posthog".
  missing: z.array(z.object({ day: analyticsDaySchema, sources: z.array(z.string()) })),
  // All-time onboarding referral answers, one entry per UTC day from the first
  // answer through yesterday, zero-filled. Source ids copy REFERRAL_SOURCES at
  // write time, plus any stored id beyond that list appended; counts align
  // with sources. The question is multi-select, so a day's counts can sum past
  // its respondents. Absent from rollups written before this shipped.
  referrals: z
    .object({
      sources: z.array(z.string()),
      days: z.array(
        z.object({
          day: analyticsDaySchema,
          respondents: z.number(),
          counts: z.array(z.number()),
        }),
      ),
    })
    .optional(),
  // Subscription and revenue rollup from the snapshot's Stripe-backed rows.
  // Counts are current state at consolidation; revenue aligns with days.
  // Absent from rollups written before this shipped.
  billing: z
    .object({
      // Pro subscriptions with an active status (active or trialing).
      subscribers: z.number(),
      // Active subscriptions set to cancel at period end.
      canceling: z.number(),
      // Subscriptions that ended after being live (canceled or unpaid);
      // abandoned checkouts never count.
      churned: z.number(),
      // Users with at least one paid Stripe grant, and their all-time total.
      funded: z.number(),
      fundedMicros: z.string(),
      // Per-day paid charges, aligned with days: Pro allowances vs top-ups
      // (one-time and auto-reload). BigInt micros as decimal strings.
      revenue: z.array(z.object({ proMicros: z.string(), topupMicros: z.string() })),
    })
    .optional(),
  users: z.array(
    z.object({
      id: z.string(),
      email: z.string(),
      name: z.string(),
      registeredAt: z.string(),
      // BigInt micros as a decimal string; "0" for users without an account row.
      balanceMicros: z.string(),
      // All-time paid Stripe grants, BigInt micros as a decimal string. Absent
      // for users who never paid and in rollups written before this shipped.
      fundedMicros: z.string().optional(),
      // One mask per entry of days; a dot is mask !== 0.
      activity: z.array(z.number()),
    }),
  ),
});
export type AnalyticsRollup = z.infer<typeof analyticsRollupSchema>;
export type AnalyticsRollupUser = AnalyticsRollup["users"][number];
export type AnalyticsReferrals = NonNullable<AnalyticsRollup["referrals"]>;
export type AnalyticsBilling = NonNullable<AnalyticsRollup["billing"]>;
