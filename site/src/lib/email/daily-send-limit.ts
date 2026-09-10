import { utcDayOf } from "@/lib/analytics/schema";
import { getGlobalSetting } from "@/lib/config/effective";
import { expectedTransactionalSends, manualHoursRemainToday, type TransactionalForecast } from "@/lib/email/send-forecast";
import { prisma } from "@/lib/prisma";

// One counter per UTC day, three ceilings on it. Manual sends run up to the
// provider's cap. Transactional sends stop below the slots held for hand-sent
// mail while work hours remain. Bulk sends stop below what the rest of the
// day is forecast to need for transactional email, so a promotion never
// blocks a welcome email and takes the slots the forecast releases as the
// day runs down. A slot is counted when it is reserved and given back when
// the send fails, so a process that dies mid-send costs the day one slot.
export type EmailSendKind = "manual" | "transactional" | "bulk";

// How long a refused send waits before asking again while the day's
// ceilings still hold slots back; they rise as the day goes on.
const FORECAST_RETRY_SECONDS = 15 * 60;

export class DailyEmailSendLimitError extends Error {
  public constructor(
    public readonly day: string,
    public readonly kind: EmailSendKind,
    public readonly limit: number,
    public readonly remaining: number,
    public readonly retryAfterSeconds: number,
  ) {
    super(`Daily email limit reached for ${kind} sends on ${day}: ${remaining} of ${limit} available.`);
    this.name = "DailyEmailSendLimitError";
  }
}

function secondsUntilNextUtcDay(now: Date): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

export type DailyEmailQuotaStatus = {
  day: string;
  sent: number;
  providerLimit: number;
  // Slots held for hand-sent mail right now; 0 once the work day is over.
  manualReserve: number;
  forecast: TransactionalForecast;
  ceilings: Record<EmailSendKind, number>;
  resetsInSeconds: number;
};

/** Where the day stands: what went, and how far each kind of send can go. */
export async function dailyEmailQuotaStatus(now = new Date()): Promise<DailyEmailQuotaStatus> {
  const day = utcDayOf(now);
  const [setting, row] = await Promise.all([
    getGlobalSetting("emailDailySend"),
    prisma.emailDailyQuota.findUnique({ select: { sent: true }, where: { day } }),
  ]);
  const manualReserve = manualHoursRemainToday(now, setting) ? setting.manualReserve : 0;
  const forecast = await expectedTransactionalSends(now, setting);
  const transactional = setting.providerLimit - manualReserve;
  return {
    day,
    sent: row?.sent ?? 0,
    providerLimit: setting.providerLimit,
    manualReserve,
    forecast,
    ceilings: { manual: setting.providerLimit, transactional, bulk: transactional - forecast.total },
    resetsInSeconds: secondsUntilNextUtcDay(now),
  };
}

async function ceilingFor(kind: EmailSendKind, now: Date): Promise<{ limit: number; floor: number }> {
  const { ceilings, forecast, providerLimit } = await dailyEmailQuotaStatus(now);
  // The lowest any ceiling can settle at tonight: the cap minus the headroom
  // the forecast keeps to the end.
  const floor = kind === "bulk" ? providerLimit - forecast.headroom : providerLimit;
  return { limit: ceilings[kind], floor };
}

async function reserveSlot(day: string, kind: EmailSendKind, now: Date): Promise<void> {
  const { limit, floor } = await ceilingFor(kind, now);
  await prisma.emailDailyQuota.createMany({ data: [{ day }], skipDuplicates: true });
  // One conditional increment: the row moves only while it is under the
  // ceiling, so two senders can never both take the last slot.
  const taken = await prisma.emailDailyQuota.updateMany({
    data: { sent: { increment: 1 } },
    where: { day, sent: { lt: limit } },
  });
  if (taken.count > 0) return;

  const row = await prisma.emailDailyQuota.findUnique({ select: { sent: true }, where: { day } });
  const sent = row?.sent ?? 0;
  const retryAfterSeconds = sent < floor ? FORECAST_RETRY_SECONDS : secondsUntilNextUtcDay(now);
  throw new DailyEmailSendLimitError(day, kind, limit, Math.max(0, limit - sent), retryAfterSeconds);
}

async function releaseSlot(day: string): Promise<void> {
  await prisma.emailDailyQuota.updateMany({
    data: { sent: { decrement: 1 } },
    where: { day, sent: { gt: 0 } },
  });
}

/** Runs one provider send inside the day's quota, with the slot held before
 * the callback starts so what it builds goes out at once. The slot is kept
 * only when the provider accepted the email: a thrown error, a resolved
 * `{ error }`, or null (nothing to send) gives it back. */
export async function withDailyEmailQuota<T extends { error: unknown }>(
  kind: EmailSendKind,
  send: () => Promise<T | null>,
): Promise<T | null> {
  const now = new Date();
  const day = utcDayOf(now);
  await reserveSlot(day, kind, now);
  const release = () =>
    releaseSlot(day).catch((releaseError) => {
      console.error("[email] failed to release a daily email slot", {
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
