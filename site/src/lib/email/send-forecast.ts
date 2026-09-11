import { getGlobalSetting } from "@/lib/config/effective";
import { pendingCreditExpiryGrants } from "@/lib/email/credit-expiry-due";
import { prisma } from "@/lib/prisma";
import type { Settings } from "@/lib/config/registry";

// What the rest of the plan's billing cycle still needs from its allowance,
// so bulk sends stop where transactional email and hand-sent mail begin and
// take whatever those leave behind as the cycle runs down.

export type EmailSendBudgetSetting = Settings["emailSendBudget"];

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function msOfUtcDay(date: Date): number {
  return date.getTime() - Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function startOfUtcDay(date: Date): Date {
  return new Date(date.getTime() - msOfUtcDay(date));
}

export type BillingCycle = { start: Date; end: Date };

// The plan renews on one day of the month, at UTC midnight here; a month
// too short for that day renews on its last day.
function renewalOn(year: number, monthIndex: number, renewalDay: number): Date {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, monthIndex, Math.min(renewalDay, lastDay)));
}

/** The billing cycle `now` falls in: from the latest renewal to the next. */
export function billingCycle(now: Date, renewalDay: number): BillingCycle {
  let start = renewalOn(now.getUTCFullYear(), now.getUTCMonth(), renewalDay);
  if (start > now) start = renewalOn(now.getUTCFullYear(), now.getUTCMonth() - 1, renewalDay);
  const end = renewalOn(start.getUTCFullYear(), start.getUTCMonth() + 1, renewalDay);
  return { start, end };
}

/** Days left in the cycle, today's remainder counted as a fraction. */
export function daysRemaining(now: Date, cycle: BillingCycle): number {
  return Math.max(0, (cycle.end.getTime() - now.getTime()) / DAY_MS);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function localParts(date: Date, timeZone: string): { day: string; hour: number; weekday: string } {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      hour: "numeric",
      hour12: false,
      month: "2-digit",
      timeZone,
      weekday: "short",
      year: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { day: `${part("year")}-${part("month")}-${part("day")}`, hour: Number(part("hour")) % 24, weekday: part("weekday") };
}

function inManualHours(local: { hour: number; weekday: string }, setting: EmailSendBudgetSetting): boolean {
  if (setting.manualWeekdaysOnly && (local.weekday === "Sat" || local.weekday === "Sun")) return false;
  return local.hour >= setting.manualStartHour && local.hour < setting.manualEndHour;
}

const workDaysCache = new Map<string, number>();

/** Work days left before the renewal, in the work zone's own calendar: the
 * local dates with a work hour still ahead, sampled at `now` and at every
 * top of the hour until the cycle ends. The answer moves by the hour, so
 * one count serves an hour of sends. */
export function workDaysRemaining(now: Date, cycle: BillingCycle, setting: EmailSendBudgetSetting): number {
  const hour = Math.floor(now.getTime() / HOUR_MS);
  const key = `${hour}:${cycle.end.getTime()}:${JSON.stringify(setting)}`;
  const cachedDays = workDaysCache.get(key);
  if (cachedDays !== undefined) return cachedDays;
  const days = new Set<string>();
  for (let t = now.getTime(); t < cycle.end.getTime(); t = Math.floor(t / HOUR_MS + 1) * HOUR_MS) {
    const local = localParts(new Date(t), setting.manualTimeZone);
    if (inManualHours(local, setting)) days.add(local.day);
  }
  workDaysCache.clear();
  workDaysCache.set(key, days.size);
  return days.size;
}

/** Signups a day, averaged over the lookback window of whole UTC days. */
async function signupsPerDay(now: Date, lookbackDays: number): Promise<number> {
  const today = startOfUtcDay(now);
  const since = new Date(today.getTime() - lookbackDays * DAY_MS);
  const count = await prisma.user.count({ where: { createdAt: { gte: since, lt: today } } });
  return count / lookbackDays;
}

// A campaign asks once per email, every half second; the answer moves by the
// hour, so one forecast serves a minute of sends.
const FORECAST_TTL_MS = 60 * 1000;
let cached: { at: number; value: Promise<TransactionalForecast> } | null = null;

export type TransactionalForecast = {
  // Welcome emails for the signups expected before the renewal.
  signups: number;
  // Expiry notices owed and not yet sent.
  expiry: number;
  headroom: number;
  total: number;
};

/** Transactional sends the rest of the cycle is expected to need. */
export function expectedTransactionalSends(
  now: Date,
  cycle: BillingCycle,
  setting: EmailSendBudgetSetting,
): Promise<TransactionalForecast> {
  if (cached && now.getTime() - cached.at < FORECAST_TTL_MS) return cached.value;
  const value = forecast(now, cycle, setting);
  cached = { at: now.getTime(), value };
  value.catch(() => {
    cached = null;
  });
  return value;
}

async function forecast(now: Date, cycle: BillingCycle, setting: EmailSendBudgetSetting): Promise<TransactionalForecast> {
  const { daysBefore } = await getGlobalSetting("creditExpiryNotice");
  const [perDay, pending] = await Promise.all([
    signupsPerDay(now, setting.signupLookbackDays),
    pendingCreditExpiryGrants(now, daysBefore),
  ]);
  const signups = Math.ceil(perDay * daysRemaining(now, cycle));
  const expiry = pending.pending.length;
  const headroom = setting.transactionalHeadroom;
  return { signups, expiry, headroom, total: signups + expiry + headroom };
}
