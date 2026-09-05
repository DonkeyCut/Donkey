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

// What the nightly run and the webhook-driven refresh read from Stripe. Money
// is BigInt micros as decimal strings; times are ISO. Every row keeps its
// Stripe id so the dashboard links straight to the object.
export const analyticsStripeSnapshotSchema = z.object({
  // Root of the Stripe dashboard for this account's mode (live or test).
  dashboardUrl: z.string(),
  // Every Pro subscription ever created, whatever its status now.
  subscriptions: z.array(
    z.object({
      id: z.string(),
      customerId: z.string().nullable(),
      userId: z.string().nullable(),
      email: z.string().nullable(),
      status: z.string(),
      createdAt: z.string(),
      // True while the subscription is live but set to end on its own.
      cancelScheduled: z.boolean(),
      // When it ends (or ended), and when the person asked for that.
      cancelAt: z.string().nullable(),
      canceledAt: z.string().nullable(),
      // What they told the portal on the way out.
      feedback: z.string().nullable(),
      comment: z.string().nullable(),
    }),
  ),
  // Every charge ever attempted: paid ones are the revenue, declined ones are
  // people who tried to pay.
  charges: z.array(
    z.object({
      id: z.string(),
      paymentIntentId: z.string().nullable(),
      customerId: z.string().nullable(),
      userId: z.string().nullable(),
      email: z.string().nullable(),
      day: analyticsDaySchema,
      kind: z.enum(["pro", "topup", "other"]),
      status: z.enum(["paid", "declined"]),
      amountMicros: z.string(),
      failure: z.string().nullable(),
    }),
  ),
  // Refunds issued inside the window.
  refunds: z.array(
    z.object({
      id: z.string(),
      chargeId: z.string().nullable(),
      day: analyticsDaySchema,
      amountMicros: z.string(),
    }),
  ),
  // Checkout pages opened inside the window that expired unpaid.
  abandonedCheckouts: z.array(
    z.object({
      id: z.string(),
      customerId: z.string().nullable(),
      email: z.string().nullable(),
      day: analyticsDaySchema,
      kind: z.enum(["pro", "topup"]),
    }),
  ),
});
export type AnalyticsStripeSnapshot = z.infer<typeof analyticsStripeSnapshotSchema>;

export const analyticsSnapshotFileSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  users: z.array(
    z.object({
      id: z.string(),
      email: z.string(),
      name: z.string(),
      createdAt: z.string(),
      // True for accounts with the super-user role.
      superUser: z.boolean().optional(),
      // The onboarding referral answer; present once the user answered.
      referralAnsweredAt: z.string().optional(),
      referralSources: z.array(z.string()).optional(),
      // The free text that comes with picking "other".
      referralOther: z.string().optional(),
    }),
  ),
  balances: z.array(z.object({ userId: z.string(), balanceMicros: z.string() })),
  // Cloud storage counters: bytes held in R2 per user, as decimal strings.
  // Absent from snapshots written before this shipped.
  storage: z.array(z.object({ userId: z.string(), bytes: z.string() })).optional(),
  // The billing record, read from Stripe. Absent from snapshots written
  // before this shipped.
  stripe: analyticsStripeSnapshotSchema.optional().catch(undefined),
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
          // The free text behind that day's "other" answers, in no order.
          others: z.array(z.string()).default([]),
        }),
      ),
    })
    .optional(),
  // Subscriptions and money, derived from the snapshot's Stripe record.
  // Counts are current state at consolidation; per-day series align with
  // days. Refreshed in place by the billing-refresh job when Stripe sends a
  // billing webhook, so it is as fresh as the last Stripe event. Absent from
  // rollups written before this shipped.
  billing: z
    .object({
      dashboardUrl: z.string(),
      // The billing window, oldest → newest, ending today: money and cancels
      // land the moment Stripe reports them, so today is part of the record.
      // The per-day series align with this list.
      days: z.array(analyticsDaySchema),
      // Pro subscriptions with an active status (active or trialing).
      subscribers: z.number(),
      // Live subscriptions set to end on their own, oldest end first.
      canceling: z.array(
        z.object({
          subscriptionId: z.string(),
          customerId: z.string().nullable(),
          email: z.string().nullable(),
          endsAt: z.string().nullable(),
          requestedAt: z.string().nullable(),
          feedback: z.string().nullable(),
          comment: z.string().nullable(),
        }),
      ),
      // Subscriptions that ended after being live (canceled or unpaid);
      // abandoned checkouts never count.
      churned: z.number(),
      // Customers with at least one paid charge, and their all-time total.
      funded: z.number(),
      fundedMicros: z.string(),
      // Window totals. Net = paid minus refunded; declined is money that was
      // attempted and never arrived, so it sits outside net.
      window: z.object({
        paidMicros: z.string(),
        refundedMicros: z.string(),
        netMicros: z.string(),
        declinedMicros: z.string(),
        declinedCustomers: z.number(),
        abandonedCheckouts: z.number(),
        cancels: z.number(),
      }),
      // Per day, aligned with billing.days. BigInt micros as decimal strings.
      revenue: z.array(
        z.object({
          proMicros: z.string(),
          topupMicros: z.string(),
          otherMicros: z.string(),
          refundedMicros: z.string(),
          declinedMicros: z.string(),
          // Cancel requests made that day.
          cancels: z.number(),
        }),
      ),
      // The window's declined charges and cancel requests, newest first, each
      // with the ids that link into Stripe.
      events: z.array(
        z.object({
          day: analyticsDaySchema,
          kind: z.enum(["declined", "canceled"]),
          email: z.string().nullable(),
          customerId: z.string().nullable(),
          // Payment intent for a decline, subscription for a cancel.
          objectId: z.string().nullable(),
          amountMicros: z.string().nullable(),
          // The decline reason, or the cancel feedback and comment.
          detail: z.string().nullable(),
        }),
      ),
    })
    .optional()
    .catch(undefined),
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
      // Cloud storage held in R2, and the account's quota at consolidation
      // (null = unlimited). Absent from rollups written before this shipped.
      storageBytes: z.string().optional(),
      storageQuotaBytes: z.number().nullable().optional(),
      // True for accounts with the super-user role.
      superUser: z.boolean().optional(),
      // One mask per entry of days; a dot is mask !== 0.
      activity: z.array(z.number()),
    }),
  ),
});
export type AnalyticsRollup = z.infer<typeof analyticsRollupSchema>;
export type AnalyticsRollupUser = AnalyticsRollup["users"][number];
export type AnalyticsReferrals = NonNullable<AnalyticsRollup["referrals"]>;
export type AnalyticsBilling = NonNullable<AnalyticsRollup["billing"]>;
