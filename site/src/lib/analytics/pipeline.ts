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
import {
  addUtcDays,
  ANALYTICS_DB_SOURCES,
  ANALYTICS_ROLLUP_VERSION,
  ANALYTICS_SOURCES,
  analyticsDbDayFileSchema,
  analyticsPosthogDayFileSchema,
  type AnalyticsDbDayFile,
  type AnalyticsPosthogDayFile,
  type AnalyticsRollup,
  type AnalyticsSnapshotFile,
  utcDayOf,
} from "@/lib/analytics/schema";
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

async function writeSnapshot(): Promise<AnalyticsSnapshotFile> {
  const users: AnalyticsSnapshotFile["users"] = [];
  let userCursor: string | undefined;
  for (;;) {
    const page = await prisma.user.findMany({
      orderBy: { id: "asc" },
      select: { createdAt: true, email: true, id: true, name: true },
      take: SNAPSHOT_PAGE_SIZE,
      ...(userCursor === undefined ? {} : { cursor: { id: userCursor }, skip: 1 }),
    });
    for (const u of page) {
      users.push({ createdAt: u.createdAt.toISOString(), email: u.email, id: u.id, name: u.name });
    }
    if (page.length < SNAPSHOT_PAGE_SIZE) break;
    userCursor = page[page.length - 1].id;
  }

  const balances: AnalyticsSnapshotFile["balances"] = [];
  let accountCursor: string | undefined;
  for (;;) {
    const page = await prisma.userCreditAccount.findMany({
      orderBy: { id: "asc" },
      select: { balanceMicros: true, id: true, userId: true },
      take: SNAPSHOT_PAGE_SIZE,
      ...(accountCursor === undefined ? {} : { cursor: { id: accountCursor }, skip: 1 }),
    });
    for (const account of page) {
      balances.push({ balanceMicros: account.balanceMicros.toString(), userId: account.userId });
    }
    if (page.length < SNAPSHOT_PAGE_SIZE) break;
    accountCursor = page[page.length - 1].id;
  }

  const snapshot: AnalyticsSnapshotFile = {
    balances,
    generatedAt: new Date().toISOString(),
    users,
    version: 1,
  };
  await putJson(SNAPSHOT_KEY, snapshot);
  return snapshot;
}

async function consolidate(
  snapshot: AnalyticsSnapshotFile,
  posthogConfigured: boolean,
): Promise<AnalyticsRollup> {
  const yesterday = addUtcDays(utcDayOf(new Date()), -1);
  const days: string[] = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) days.push(addUtcDays(yesterday, -i));

  const masks = new Map<string, number[]>();
  for (const user of snapshot.users) masks.set(user.id, days.map(() => 0));

  const posthogBit = 1 << ANALYTICS_SOURCES.indexOf("posthog");
  const missing: AnalyticsRollup["missing"] = [];
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const absent: string[] = [];

    const dbFile = readJson(await getObject(dayDbKey(day)), analyticsDbDayFileSchema);
    if (!dbFile) {
      absent.push("db");
    } else {
      for (const source of ANALYTICS_DB_SOURCES) {
        const bit = 1 << ANALYTICS_SOURCES.indexOf(source);
        for (const id of dbFile.active[source] ?? []) {
          const mask = masks.get(id);
          if (mask) mask[i] |= bit;
        }
      }
    }

    if (posthogConfigured) {
      const posthogFile = readJson(
        await getObject(dayPosthogKey(day)),
        analyticsPosthogDayFileSchema,
      );
      if (!posthogFile) {
        absent.push("posthog");
      } else {
        // Anonymous pre-sign-in distinct_ids match no snapshot user and drop out.
        for (const id of posthogFile.activeDistinctIds) {
          const mask = masks.get(id);
          if (mask) mask[i] |= posthogBit;
        }
      }
    }

    if (absent.length > 0) missing.push({ day, sources: absent });
  }

  const balanceByUser = new Map(snapshot.balances.map((b) => [b.userId, b.balanceMicros]));
  const users = snapshot.users
    .map((u) => ({
      activity: masks.get(u.id) ?? days.map(() => 0),
      balanceMicros: balanceByUser.get(u.id) ?? "0",
      email: u.email,
      id: u.id,
      name: u.name,
      registeredAt: u.createdAt,
    }))
    .sort((a, b) => (a.registeredAt < b.registeredAt ? 1 : -1));

  const rollup: AnalyticsRollup = {
    days,
    generatedAt: new Date().toISOString(),
    missing,
    sources: [...ANALYTICS_SOURCES],
    users,
    version: ANALYTICS_ROLLUP_VERSION,
  };
  await putJson(ROLLUP_KEY, rollup);
  return rollup;
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
