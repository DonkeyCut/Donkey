import { utcDayOf } from "@/lib/analytics/schema";
import { getGlobalSetting } from "@/lib/config/effective";
import {
  billingCycle,
  expectedTransactionalSends,
  workDaysRemaining,
  type BillingCycle,
  type TransactionalForecast,
} from "@/lib/email/send-forecast";
import { prisma } from "@/lib/prisma";

// The plan's monthly allowance, spent across its billing cycle with three
// ceilings on it. Manual sends run up to the allowance. Transactional sends
// stop below the slots held for hand-sent mail on the work days left.
// Bulk sends stop below what the rest of the cycle is forecast to need for
// transactional email, so a campaign of any size goes out the day it is
// sent and never blocks a welcome email, and takes the slots the forecast
// releases as the cycle runs down. The count is kept per UTC day: a slot is
// counted when it is reserved and given back when the send fails, so a
// process that dies mid-send costs the cycle one slot.
export type EmailSendKind = "manual" | "transactional" | "bulk";

// How long a refused send waits before asking again while the reserves
// still hold slots back; they release as work days and cycle days pass.
const RESERVE_RETRY_SECONDS = 60 * 60;

export class EmailBudgetError extends Error {
  public constructor(
    public readonly kind: EmailSendKind,
    public readonly limit: number,
    public readonly remaining: number,
    public readonly retryAfterSeconds: number,
  ) {
    super(`Email budget reached for ${kind} sends this cycle: ${remaining} of ${limit} available.`);
    this.name = "EmailBudgetError";
  }
}

function secondsUntil(date: Date, now: Date): number {
  return Math.max(1, Math.ceil((date.getTime() - now.getTime()) / 1000));
}

export type EmailBudgetStatus = {
  cycle: { start: string; end: string };
  // Sent this cycle, and the part of that sent today.
  sent: number;
  sentToday: number;
  allowance: number;
  // Slots held for hand-sent mail over the work days left in the cycle.
  manualReserve: number;
  forecast: TransactionalForecast;
  // How far each kind of send may go this cycle.
  ceilings: Record<EmailSendKind, number>;
  renewsInSeconds: number;
};

function cycleDays(cycle: BillingCycle) {
  return { gte: utcDayOf(cycle.start), lt: utcDayOf(cycle.end) };
}

/** Where the cycle stands: what went, and how far each kind of send can go. */
export async function emailBudgetStatus(now = new Date()): Promise<EmailBudgetStatus> {
  const setting = await getGlobalSetting("emailSendBudget");
  const cycle = billingCycle(now, setting.renewalDay);
  const today = utcDayOf(now);
  const [total, todayRow] = await Promise.all([
    prisma.emailDailyQuota.aggregate({ _sum: { sent: true }, where: { day: cycleDays(cycle) } }),
    prisma.emailDailyQuota.findUnique({ select: { sent: true }, where: { day: today } }),
  ]);
  const manualReserve = setting.manualReserve * workDaysRemaining(now, cycle, setting);
  const forecast = await expectedTransactionalSends(now, cycle, setting);
  const transactional = setting.monthlyAllowance - manualReserve;
  return {
    cycle: { start: cycle.start.toISOString(), end: cycle.end.toISOString() },
    sent: total._sum.sent ?? 0,
    sentToday: todayRow?.sent ?? 0,
    allowance: setting.monthlyAllowance,
    manualReserve,
    forecast,
    ceilings: { manual: setting.monthlyAllowance, transactional, bulk: transactional - forecast.total },
    renewsInSeconds: secondsUntil(cycle.end, now),
  };
}

async function reserveSlot(day: string, kind: EmailSendKind, now: Date): Promise<void> {
  const status = await emailBudgetStatus(now);
  const limit = status.ceilings[kind];
  // Today's row may climb to the cycle ceiling less what earlier days spent.
  const todayLimit = limit - (status.sent - status.sentToday);
  await prisma.emailDailyQuota.createMany({ data: [{ day }], skipDuplicates: true });
  // One conditional increment: the row moves only while it is under the
  // ceiling, so two senders can never both take the last slot.
  const taken = await prisma.emailDailyQuota.updateMany({
    data: { sent: { increment: 1 } },
    where: { day, sent: { lt: todayLimit } },
  });
  if (taken.count > 0) return;

  // The lowest the ceiling can settle at before the renewal: the allowance
  // less the headroom the forecast keeps to the end. Under it, the reserves
  // are what holds the send back and they release with time; at it, the
  // plan is spent until it renews.
  const floor = kind === "bulk" ? status.allowance - status.forecast.headroom : status.allowance;
  const retryAfterSeconds = status.sent < floor ? RESERVE_RETRY_SECONDS : status.renewsInSeconds;
  throw new EmailBudgetError(kind, limit, Math.max(0, limit - status.sent), retryAfterSeconds);
}

async function releaseSlot(day: string): Promise<void> {
  await prisma.emailDailyQuota.updateMany({
    data: { sent: { decrement: 1 } },
    where: { day, sent: { gt: 0 } },
  });
}

/** Runs one provider send inside the cycle's budget, with the slot held
 * before the callback starts so what it builds goes out at once. The slot is
 * kept only when the provider accepted the email: a thrown error, a resolved
 * `{ error }`, or null (nothing to send) gives it back. */
export async function withEmailBudget<T extends { error: unknown }>(
  kind: EmailSendKind,
  send: () => Promise<T | null>,
): Promise<T | null> {
  const now = new Date();
  const day = utcDayOf(now);
  await reserveSlot(day, kind, now);
  const release = () =>
    releaseSlot(day).catch((releaseError) => {
      console.error("[email] failed to release an email budget slot", {
        day,
        error: releaseError instanceof Error ? releaseError.message : String(releaseError),
      });
    });
  let result: T | null;
  try {
    result = await send();
  } catch (error) {
    await release();
    throw error;
  }
  if (result === null || result.error) await release();
  return result;
}
