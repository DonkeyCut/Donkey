// Nightly analytics pipeline. Extraction writes one small JSON file per day
// per source to R2, a snapshot of users and balances is rewritten every run,
// and consolidation folds the window into the single rollup.json the
// superuser dashboard reads. Idempotency is per day: a day file is *final*
// once it was written after its UTC day closed, and final files are skipped
// unless forced — so a premature run of today, a per-day retrigger, and the
// regular nightly run all compose without redoing finished work.
import type { z } from "zod";

import type { Prisma } from "@/generated/prisma/client";
import { getObject, listObjectsWithDates, putObject } from "@/cut/server/cloud/r2";
import { fetchActiveDistinctIds, isPosthogQueryConfigured } from "@/lib/analytics/posthog";
import { pullStripeSnapshot } from "@/lib/analytics/stripe";
import {
  addUtcDays,
  ANALYTICS_DB_SOURCES,
  ANALYTICS_ROLLUP_VERSION,
  ANALYTICS_SOURCES,
  analyticsDbDayFileSchema,
  analyticsPosthogDayFileSchema,
  analyticsRollupSchema,
  analyticsSnapshotFileSchema,
  type AnalyticsDbDayFile,
  type AnalyticsPosthogDayFile,
  type AnalyticsRollup,
  type AnalyticsSnapshotFile,
  type AnalyticsStripeSnapshot,
  utcDayOf,
} from "@/lib/analytics/schema";
import { cutLimitsForTier } from "@/cut/server/cloud/limits";
import { isActiveProStatus } from "@/lib/billing/pro-subscription";
import { REFERRAL_SOURCES } from "@/lib/onboarding/sequence";
import { prisma } from "@/lib/prisma";

const ANALYTICS_PREFIX = "analytics/";
const DAYS_PREFIX = `${ANALYTICS_PREFIX}days/`;
export const dayDbKey = (day: string) => `${DAYS_PREFIX}${day}/db.json`;
export const dayPosthogKey = (day: string) => `${DAYS_PREFIX}${day}/posthog.json`;
export const SNAPSHOT_KEY = `${ANALYTICS_PREFIX}snapshot.json`;
export const ROLLUP_KEY = `${ANALYTICS_PREFIX}rollup.json`;

const WINDOW_DAYS = 60;
// Backfill after an outage converges over nights instead of one heavy run.
const MAX_EXTRACT_DAYS_PER_RUN = 5;
const SNAPSHOT_PAGE_SIZE = 1000;

// The rollup's day window: yesterday and the days before it, oldest first.
// Activity is extracted once a UTC day has closed, so today is never in it.
function windowDays(): string[] {
  return daysEnding(addUtcDays(utcDayOf(new Date()), -1));
}

// The billing window ends today: Stripe reports money and cancels as they
// happen, and the webhook refresh exists to show them the same day.
function billingDays(): string[] {
  return daysEnding(utcDayOf(new Date()));
}

function daysEnding(last: string): string[] {
  const days: string[] = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) days.push(addUtcDays(last, -i));
  return days;
}

export class InvalidDayError extends Error {}

export async function runAnalyticsDaily(payload: {
  day?: string;
  force?: boolean;
}): Promise<Prisma.InputJsonValue> {
  const today = utcDayOf(new Date());
  if (payload.day !== undefined) {
    if (addUtcDays(payload.day, 0) !== payload.day) {
      throw new InvalidDayError(`"${payload.day}" is not a calendar day.`);
    }
    if (payload.day > today) {
      throw new InvalidDayError(`"${payload.day}" is in the future.`);
    }
  }

  const posthogConfigured = isPosthogQueryConfigured();
  const lastWrite = new Map(
    (await listObjectsWithDates(DAYS_PREFIX)).map((o) => [o.key, o.lastModified]),
  );
  // Final = written after the UTC day closed. A premature mid-day extraction
  // of today stays non-final, so the nightly run redoes it once the day is
  // whole; a manual retrigger of a past day skips whatever already finished.
  const isFinal = (key: string, day: string) => {
    const at = lastWrite.get(key);
    return at !== undefined && at.getTime() >= Date.parse(`${addUtcDays(day, 1)}T00:00:00Z`);
  };
  const isComplete = (day: string) =>
    isFinal(dayDbKey(day), day) && (!posthogConfigured || isFinal(dayPosthogKey(day), day));

  const yesterday = addUtcDays(today, -1);
  let targets: string[];
  if (payload.day) {
    targets = [payload.day];
  } else {
    targets = [];
    for (let i = 0; i < WINDOW_DAYS; i++) {
      const day = addUtcDays(yesterday, -i); // newest first
      if (!isComplete(day)) targets.push(day);
    }
  }
  const deferred = Math.max(0, targets.length - MAX_EXTRACT_DAYS_PER_RUN);
  targets = targets.slice(0, MAX_EXTRACT_DAYS_PER_RUN);

  // A failed source is recorded and retried by the next night's backfill; it
  // never blocks the other source, other days, the snapshot, or the rollup.
  const errors: { day: string; source: string; message: string }[] = [];
  let extracted = 0;
  let skipped = 0;
  for (const day of targets) {
    if (!payload.force && isFinal(dayDbKey(day), day)) {
      skipped++;
    } else {
      try {
        await putJson(dayDbKey(day), await extractDbDay(day));
        extracted++;
      } catch (e) {
        errors.push({ day, message: messageOf(e), source: "db" });
      }
    }
    if (!posthogConfigured) continue;
    if (!payload.force && isFinal(dayPosthogKey(day), day)) {
      skipped++;
    } else {
      try {
        await putJson(dayPosthogKey(day), await extractPosthogDay(day));
        extracted++;
      } catch (e) {
        errors.push({ day, message: messageOf(e), source: "posthog" });
      }
    }
  }

  // Snapshot and rollup errors propagate: they mean the database or storage
  // itself is unhealthy, which is the queue's transient-retry case.
  const snapshot = await writeSnapshot();
  const rollup = await consolidate(snapshot, posthogConfigured);

  return {
    deferred,
    errors,
    extracted,
    rollupDays: rollup.days.length,
    rollupUsers: rollup.users.length,
    skipped,
    snapshotUsers: snapshot.users.length,
    targetedDays: targets,
  };
}

async function extractDbDay(day: string): Promise<AnalyticsDbDayFile> {
  const range = {
    createdAt: {
      gte: new Date(`${day}T00:00:00Z`),
      lt: new Date(`${addUtcDays(day, 1)}T00:00:00Z`),
    },
  };
  // One bounded group-by per event table, run serially to keep the load light.
  // Every table indexes (userId, createdAt).
  const queries = {
    copies: () => prisma.cutCopyJob.groupBy({ by: ["userId"], where: range }),
    creditLedger: () => prisma.userCreditLedgerEntry.groupBy({ by: ["userId"], where: range }),
    inference: () => prisma.inferenceUsageEvent.groupBy({ by: ["userId"], where: range }),
    libraryAssets: () => prisma.cutLibraryAsset.groupBy({ by: ["userId"], where: range }),
    renders: () => prisma.cutRenderJob.groupBy({ by: ["userId"], where: range }),
    templates: () => prisma.cutTemplate.groupBy({ by: ["userId"], where: range }),
  };
  const active: AnalyticsDbDayFile["active"] = {};
  for (const source of ANALYTICS_DB_SOURCES) {
    active[source] = (await queries[source]()).map((row) => row.userId).sort();
  }
  return { active, day, generatedAt: new Date().toISOString(), version: 1 };
}

async function extractPosthogDay(day: string): Promise<AnalyticsPosthogDayFile> {
  return {
    activeDistinctIds: await fetchActiveDistinctIds(day),
    day,
    generatedAt: new Date().toISOString(),
    version: 1,
  };
}

// Drain a cursor-paginated query. The page function spreads the cursor args
// into its findMany, so every table pages the same way.
async function fetchAllPages<T extends { id: string }>(
  fetchPage: (cursorArgs: { cursor: { id: string }; skip: 1 } | undefined) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(
      cursor === undefined ? undefined : { cursor: { id: cursor }, skip: 1 },
    );
    rows.push(...page);
    if (page.length < SNAPSHOT_PAGE_SIZE) return rows;
    cursor = page[page.length - 1].id;
  }
}

async function writeSnapshot(): Promise<AnalyticsSnapshotFile> {
  const users = (
    await fetchAllPages((cursorArgs) =>
      prisma.user.findMany({
        orderBy: { id: "asc" },
        select: {
          createdAt: true,
          email: true,
          id: true,
          name: true,
          onboarding: {
            select: { referralAnsweredAt: true, referralOther: true, referralSources: true },
          },
          superUser: true,
        },
        take: SNAPSHOT_PAGE_SIZE,
        ...cursorArgs,
      }),
    )
  ).map((u) => ({
    createdAt: u.createdAt.toISOString(),
    email: u.email,
    id: u.id,
    name: u.name,
    ...(u.superUser ? { superUser: true } : {}),
    ...(u.onboarding?.referralAnsweredAt
      ? {
          referralAnsweredAt: u.onboarding.referralAnsweredAt.toISOString(),
          referralSources: u.onboarding.referralSources,
          ...(u.onboarding.referralOther?.trim()
            ? { referralOther: u.onboarding.referralOther.trim() }
            : {}),
        }
      : {}),
  }));

  const balances = (
    await fetchAllPages((cursorArgs) =>
      prisma.userCreditAccount.findMany({
        orderBy: { id: "asc" },
        select: { balanceMicros: true, id: true, userId: true },
        take: SNAPSHOT_PAGE_SIZE,
        ...cursorArgs,
      }),
    )
  ).map((account) => ({
    balanceMicros: account.balanceMicros.toString(),
    userId: account.userId,
  }));

  // CutStorageUsage keys on userId, so it pages on that column.
  const storage: { bytes: string; userId: string }[] = [];
  for (let cursor: string | undefined; ; ) {
    const page = await prisma.cutStorageUsage.findMany({
      orderBy: { userId: "asc" },
      select: { bytes: true, userId: true },
      take: SNAPSHOT_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor: { userId: cursor }, skip: 1 }),
    });
    storage.push(...page.map((row) => ({ bytes: row.bytes.toString(), userId: row.userId })));
    if (page.length < SNAPSHOT_PAGE_SIZE) break;
    cursor = page[page.length - 1].userId;
  }

  const stripe = await pullStripeSnapshot(billingDays()[0]);

  const snapshot: AnalyticsSnapshotFile = {
    balances,
    generatedAt: new Date().toISOString(),
    storage,
    stripe,
    users,
    version: 1,
  };
  await putJson(SNAPSHOT_KEY, snapshot);
  return snapshot;
}

// One day's stored inputs to consolidation, null where a file was absent or
// unreadable.
export type AnalyticsDayFiles = {
  db: AnalyticsDbDayFile | null;
  posthog: AnalyticsPosthogDayFile | null;
};

async function consolidate(
  snapshot: AnalyticsSnapshotFile,
  posthogConfigured: boolean,
): Promise<AnalyticsRollup> {
  const rollup = await buildRollup({
    billingDays: billingDays(),
    days: windowDays(),
    generatedAt: new Date().toISOString(),
    posthogConfigured,
    readDayFiles: async (day) => ({
      db: readJson(await getObject(dayDbKey(day)), analyticsDbDayFileSchema),
      posthog: posthogConfigured
        ? readJson(await getObject(dayPosthogKey(day)), analyticsPosthogDayFileSchema)
        : null,
    }),
    snapshot,
  });
  await putJson(ROLLUP_KEY, rollup);
  return rollup;
}

// The whole rollup from its inputs. Day files come through the reader one
// day at a time, so a 60-day window holds one day's ids at once; nothing here
// touches storage or the clock. Every rollup in storage came out of this
// function, so the fixture the phone's model is tested against comes out of
// it too (rollup-fixture.ts): a change to what the dashboard is served
// reaches that test in the same change.
export async function buildRollup(input: {
  snapshot: AnalyticsSnapshotFile;
  // The activity window, oldest first; every user's activity aligns with it.
  days: string[];
  // The billing window, oldest first, ending today.
  billingDays: string[];
  readDayFiles: (day: string) => Promise<AnalyticsDayFiles>;
  posthogConfigured: boolean;
  generatedAt: string;
}): Promise<AnalyticsRollup> {
  const { days, snapshot } = input;
  const yesterday = days[days.length - 1];

  const masks = new Map<string, number[]>();
  for (const user of snapshot.users) masks.set(user.id, days.map(() => 0));

  const posthogBit = 1 << ANALYTICS_SOURCES.indexOf("posthog");
  const missing: AnalyticsRollup["missing"] = [];
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const absent: string[] = [];
    const files = await input.readDayFiles(day);

    if (!files.db) {
      absent.push("db");
    } else {
      for (const source of ANALYTICS_DB_SOURCES) {
        const bit = 1 << ANALYTICS_SOURCES.indexOf(source);
        for (const id of files.db.active[source] ?? []) {
          const mask = masks.get(id);
          if (mask) mask[i] |= bit;
        }
      }
    }

    if (input.posthogConfigured) {
      if (!files.posthog) {
        absent.push("posthog");
      } else {
        // Anonymous pre-sign-in distinct_ids match no snapshot user and drop out.
        for (const id of files.posthog.activeDistinctIds) {
          const mask = masks.get(id);
          if (mask) mask[i] |= posthogBit;
        }
      }
    }

    if (absent.length > 0) missing.push({ day, sources: absent });
  }

  const balanceByUser = new Map(snapshot.balances.map((b) => [b.userId, b.balanceMicros]));
  const fundedByUser = fundedMicrosByUser(snapshot.stripe);
  const storageByUser = new Map((snapshot.storage ?? []).map((s) => [s.userId, s.bytes]));
  const proUsers = new Set(
    (snapshot.stripe?.subscriptions ?? [])
      .filter((sub) => isActiveProStatus(sub.status))
      .map((sub) => sub.userId),
  );
  const users = snapshot.users
    .map((u) => {
      const funded = fundedByUser.get(u.id);
      const limits = cutLimitsForTier({ superUser: u.superUser === true, pro: proUsers.has(u.id) });
      return {
        activity: masks.get(u.id) ?? days.map(() => 0),
        balanceMicros: balanceByUser.get(u.id) ?? "0",
        email: u.email,
        ...(funded !== undefined ? { fundedMicros: funded.toString() } : {}),
        id: u.id,
        name: u.name,
        registeredAt: u.createdAt,
        storageBytes: storageByUser.get(u.id) ?? "0",
        storageQuotaBytes: limits.storageBytes,
        ...(u.superUser ? { superUser: true } : {}),
      };
    })
    .sort((a, b) => (a.registeredAt < b.registeredAt ? 1 : -1));

  return {
    ...(snapshot.stripe ? { billing: buildBilling(snapshot.stripe, input.billingDays) } : {}),
    days,
    generatedAt: input.generatedAt,
    missing,
    referrals: buildReferrals(snapshot, yesterday),
    sources: [...ANALYTICS_SOURCES],
    users,
    version: ANALYTICS_ROLLUP_VERSION,
  };
}

// All-time paid charges per user, for the user list's funded column.
function fundedMicrosByUser(stripe: AnalyticsStripeSnapshot | undefined): Map<string, bigint> {
  const funded = new Map<string, bigint>();
  for (const charge of stripe?.charges ?? []) {
    if (charge.status !== "paid" || !charge.userId) continue;
    funded.set(
      charge.userId,
      (funded.get(charge.userId) ?? BigInt(0)) + BigInt(charge.amountMicros),
    );
  }
  return funded;
}

// The Stripe record folded into what the dashboard shows: subscription state
// now, per-day money, and the window's declines and cancel requests with the
// ids that link into Stripe. Abandoned checkouts never subscribed, so they
// count nowhere in churn; past_due and paused sit outside both buckets until
// Stripe resolves them.
export function buildBilling(
  stripe: AnalyticsStripeSnapshot,
  days: string[],
): NonNullable<AnalyticsRollup["billing"]> {
  type Billing = NonNullable<AnalyticsRollup["billing"]>;
  const dayIndex = new Map(days.map((day, i) => [day, i]));
  const inWindow = (iso: string | null) => iso !== null && dayIndex.has(utcDayOf(new Date(iso)));

  let subscribers = 0;
  let churned = 0;
  const canceling: Billing["canceling"] = [];
  const events: Billing["events"] = [];
  const revenue = days.map(() => ({
    cancels: 0,
    declinedMicros: BigInt(0),
    otherMicros: BigInt(0),
    proMicros: BigInt(0),
    refundedMicros: BigInt(0),
    topupMicros: BigInt(0),
  }));

  for (const sub of stripe.subscriptions) {
    if (isActiveProStatus(sub.status)) {
      subscribers++;
      if (sub.cancelScheduled) {
        canceling.push({
          comment: sub.comment,
          customerId: sub.customerId,
          email: sub.email,
          endsAt: sub.cancelAt,
          feedback: sub.feedback,
          requestedAt: sub.canceledAt,
          subscriptionId: sub.id,
        });
      }
    } else if (sub.status === "canceled" || sub.status === "unpaid") {
      churned++;
    }
    // A cancel request lands on the day it was made, whether the
    // subscription is still running out its period or already ended.
    if (sub.canceledAt !== null && inWindow(sub.canceledAt)) {
      const day = utcDayOf(new Date(sub.canceledAt));
      revenue[dayIndex.get(day)!].cancels++;
      events.push({
        amountMicros: null,
        customerId: sub.customerId,
        day,
        detail: [sub.feedback, sub.comment].filter(Boolean).join(" · ") || null,
        email: sub.email,
        ended: !isActiveProStatus(sub.status),
        endsAt: sub.cancelAt ?? sub.endedAt,
        kind: "canceled",
        objectId: sub.id,
      });
    }
  }
  canceling.sort((a, b) => (a.endsAt ?? "").localeCompare(b.endsAt ?? ""));

  const fundedCustomers = new Set<string>();
  let fundedMicros = BigInt(0);
  let paidMicros = BigInt(0);
  let declinedMicros = BigInt(0);
  const declinedCustomers = new Set<string>();
  for (const charge of stripe.charges) {
    const amount = BigInt(charge.amountMicros);
    const i = dayIndex.get(charge.day);
    if (charge.status === "paid") {
      fundedMicros += amount;
      fundedCustomers.add(charge.customerId ?? charge.id);
      if (i === undefined) continue;
      paidMicros += amount;
      if (charge.kind === "pro") revenue[i].proMicros += amount;
      else if (charge.kind === "topup") revenue[i].topupMicros += amount;
      else revenue[i].otherMicros += amount;
    } else if (i !== undefined) {
      declinedMicros += amount;
      declinedCustomers.add(charge.customerId ?? charge.id);
      revenue[i].declinedMicros += amount;
      events.push({
        amountMicros: charge.amountMicros,
        customerId: charge.customerId,
        day: charge.day,
        detail: charge.failure,
        email: charge.email,
        ended: false,
        endsAt: null,
        kind: "declined",
        objectId: charge.paymentIntentId,
      });
    }
  }

  let refundedMicros = BigInt(0);
  for (const refund of stripe.refunds) {
    const i = dayIndex.get(refund.day);
    if (i === undefined) continue;
    refundedMicros += BigInt(refund.amountMicros);
    revenue[i].refundedMicros += BigInt(refund.amountMicros);
  }

  events.sort((a, b) => b.day.localeCompare(a.day));

  return {
    canceling,
    churned,
    dashboardUrl: stripe.dashboardUrl,
    days,
    events,
    funded: fundedCustomers.size,
    fundedMicros: fundedMicros.toString(),
    revenue: revenue.map((entry) => ({
      cancels: entry.cancels,
      declinedMicros: entry.declinedMicros.toString(),
      otherMicros: entry.otherMicros.toString(),
      proMicros: entry.proMicros.toString(),
      refundedMicros: entry.refundedMicros.toString(),
      topupMicros: entry.topupMicros.toString(),
    })),
    subscribers,
    window: {
      abandonedCheckouts: stripe.abandonedCheckouts.filter((c) => dayIndex.has(c.day)).length,
      cancels: revenue.reduce((sum, entry) => sum + entry.cancels, 0),
      declinedCustomers: declinedCustomers.size,
      declinedMicros: declinedMicros.toString(),
      netMicros: (paidMicros - refundedMicros).toString(),
      paidMicros: paidMicros.toString(),
      refundedMicros: refundedMicros.toString(),
    },
  };
}

// A Stripe billing webhook lands here: the Stripe record is re-read, the
// snapshot keeps it for the next nightly consolidation, and the rollup's
// billing section (plus each user's funded total) is rewritten in place so
// the dashboard shows the event without waiting for the night. Without a
// snapshot or rollup yet there is nothing to refresh; the nightly run builds
// them.
export async function refreshBilling(): Promise<Prisma.InputJsonValue> {
  const [snapshot, rollup] = await Promise.all([
    getObject(SNAPSHOT_KEY).then((obj) => readJson(obj, analyticsSnapshotFileSchema)),
    getObject(ROLLUP_KEY).then((obj) => readJson(obj, analyticsRollupSchema)),
  ]);
  if (!snapshot || !rollup) return { refreshed: false };

  const days = billingDays();
  const stripe = await pullStripeSnapshot(days[0]);
  await putJson(SNAPSHOT_KEY, { ...snapshot, stripe });

  const fundedByUser = fundedMicrosByUser(stripe);
  const users = rollup.users.map((user) => ({
    ...user,
    fundedMicros: fundedByUser.get(user.id)?.toString(),
  }));
  await putJson(ROLLUP_KEY, { ...rollup, billing: buildBilling(stripe, days), users });
  return {
    charges: stripe.charges.length,
    refreshed: true,
    subscriptions: stripe.subscriptions.length,
  };
}

// The snapshot covers every user, so this recomputes the whole referral
// history each run — an answer moved by a replayed onboarding lands on its
// new day with nothing left behind on the old one.
function buildReferrals(
  snapshot: AnalyticsSnapshotFile,
  through: string,
): AnalyticsRollup["referrals"] {
  const answered = snapshot.users
    .flatMap((u) =>
      u.referralAnsweredAt === undefined
        ? []
        : [
            {
              day: utcDayOf(new Date(u.referralAnsweredAt)),
              other: u.referralOther,
              sources: u.referralSources ?? [],
            },
          ],
    )
    .filter((a) => a.day <= through);
  if (answered.length === 0) return undefined;

  const sources: string[] = REFERRAL_SOURCES.map((s) => s.id);
  for (const a of answered) {
    for (const id of a.sources) if (!sources.includes(id)) sources.push(id);
  }

  const first = answered.reduce((min, a) => (a.day < min ? a.day : min), through);
  const byDay = new Map<
    string,
    { day: string; respondents: number; counts: number[]; others: string[] }
  >();
  const days: NonNullable<AnalyticsRollup["referrals"]>["days"] = [];
  for (let day = first; day <= through; day = addUtcDays(day, 1)) {
    const entry = { counts: sources.map(() => 0), day, others: [], respondents: 0 };
    byDay.set(day, entry);
    days.push(entry);
  }
  for (const a of answered) {
    const entry = byDay.get(a.day);
    if (!entry) continue;
    entry.respondents++;
    if (a.other) entry.others.push(a.other);
    for (const id of a.sources) entry.counts[sources.indexOf(id)]++;
  }
  return { days, sources };
}

async function putJson(key: string, value: unknown): Promise<void> {
  await putObject(key, Buffer.from(JSON.stringify(value)), "application/json");
}

/** Parse a stored JSON object against its schema; anything unreadable — gone,
 * corrupt, or from an incompatible version — reads as missing. */
function readJson<T>(obj: { bytes: Buffer } | null, schema: z.ZodType<T>): T | null {
  if (!obj) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(obj.bytes.toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
