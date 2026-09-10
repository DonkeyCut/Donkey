import { getGlobalSetting } from "@/lib/config/effective";
import { pendingCreditExpiryGrants } from "@/lib/email/credit-expiry-due";
import { prisma } from "@/lib/prisma";
import type { Settings } from "@/lib/config/registry";

// What the rest of the UTC day still needs from the provider's send cap, so
// bulk sends stop where transactional email and hand-sent mail begin and take
// whatever those leave behind as the day runs down.

export type EmailDailySendSetting = Settings["emailDailySend"];

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function msOfUtcDay(date: Date): number {
  return date.getTime() - Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function startOfUtcDay(date: Date): Date {
  return new Date(date.getTime() - msOfUtcDay(date));
}

function localHourAndWeekday(date: Date, timeZone: string): { hour: number; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone, weekday: "short" }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  return { hour, weekday };
}

function inManualHours(date: Date, setting: EmailDailySendSetting): boolean {
  const { hour, weekday } = localHourAndWeekday(date, setting.manualTimeZone);
  if (setting.manualWeekdaysOnly && (weekday === "Sat" || weekday === "Sun")) return false;
  return hour >= setting.manualStartHour && hour < setting.manualEndHour;
}

/** Whether any work hour is still ahead in the current UTC day, sampled at
 * now and at every top of the hour until UTC midnight. */
export function manualHoursRemainToday(now: Date, setting: EmailDailySendSetting): boolean {
  const dayEnd = startOfUtcDay(now).getTime() + DAY_MS;
  for (let t = now.getTime(); t < dayEnd; t = Math.floor(t / HOUR_MS + 1) * HOUR_MS) {
    if (inManualHours(new Date(t), setting)) return true;
  }
  return false;
}

/** Welcome emails still expected today: signups over the lookback window that
 * landed later in their UTC day than now is in this one, averaged per day. */
async function expectedSignupsRemaining(now: Date, lookbackDays: number): Promise<number> {
  const today = startOfUtcDay(now);
  const since = new Date(today.getTime() - lookbackDays * DAY_MS);
  const users = await prisma.user.findMany({
    select: { createdAt: true },
    where: { createdAt: { gte: since, lt: today } },
  });
  const cutoff = msOfUtcDay(now);
  const later = users.filter((u) => msOfUtcDay(u.createdAt) >= cutoff).length;
  return Math.ceil(later / lookbackDays);
}

// A campaign asks once per email, every half second; the answer moves by the
// hour, so one forecast serves a minute of sends.
const FORECAST_TTL_MS = 60 * 1000;
let cached: { at: number; value: Promise<TransactionalForecast> } | null = null;

export type TransactionalForecast = {
  // Welcome emails for the signups still expected today.
  signups: number;
  // Expiry notices owed and not yet sent.
  expiry: number;
  headroom: number;
  total: number;
};

/** Transactional sends the rest of today is expected to need. */
export function expectedTransactionalSends(now: Date, setting: EmailDailySendSetting): Promise<TransactionalForecast> {
  if (cached && now.getTime() - cached.at < FORECAST_TTL_MS) return cached.value;
  const value = forecast(now, setting);
  cached = { at: now.getTime(), value };
  value.catch(() => {
    cached = null;
  });
  return value;
}

async function forecast(now: Date, setting: EmailDailySendSetting): Promise<TransactionalForecast> {
  const { daysBefore } = await getGlobalSetting("creditExpiryNotice");
  const [signups, pending] = await Promise.all([
    expectedSignupsRemaining(now, setting.signupLookbackDays),
    pendingCreditExpiryGrants(now, daysBefore),
  ]);
  const expiry = pending.pending.length;
  const headroom = setting.transactionalHeadroom;
  return { signups, expiry, headroom, total: signups + expiry + headroom };
}
