// The analytics rollup as the API reads it. The back office's nightly
// pipeline writes rollup.json to R2 and keeps its own copy of this contract;
// the summary and users routes read rollup.json only — never the database —
// so this file is the whole interface between them.
import { z } from "zod";

export const ANALYTICS_ROLLUP_VERSION = 1;

// Where the pipeline writes the rollup in R2.
export const ROLLUP_KEY = "analytics/rollup.json";

const analyticsDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// The consolidated window the UI renders. Users come from the latest snapshot,
// so an account deleted since then carries no history here.
export const analyticsRollupSchema = z.object({
  version: z.literal(ANALYTICS_ROLLUP_VERSION),
  generatedAt: z.string(),
  // Oldest → newest; every user's activity array aligns with this.
  days: z.array(analyticsDaySchema),
  // Bit order of the activity masks (the pipeline's source list at write time).
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
      // The window's paid and declined charges and cancel requests, newest
      // first, each with the ids that link into Stripe. Paid charges are
      // absent from rollups written before they shipped.
      events: z.array(
        z.object({
          day: analyticsDaySchema,
          kind: z.enum(["paid", "declined", "canceled"]),
          email: z.string().nullable(),
          customerId: z.string().nullable(),
          // Payment intent for a charge, subscription for a cancel.
          objectId: z.string().nullable(),
          amountMicros: z.string().nullable(),
          // What a paid charge bought (pro, topup, other), the decline
          // reason, or the cancel feedback and comment.
          detail: z.string().nullable(),
          // For a cancel: when the subscription ends (or ended), and whether
          // it has already stopped.
          endsAt: z.string().nullable().catch(null),
          ended: z.boolean().catch(false),
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
