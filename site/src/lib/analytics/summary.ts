// The rollup reduced to what a dashboard draws: one point per day plus the
// headline numbers. The phone reads this and never the rollup itself — the
// rollup carries every registered account's email, name, balance, and 60-day
// activity mask, so it grows with signups and has no business on a device that
// renders eight aggregates.
import type { AnalyticsRollup } from "@/lib/analytics/schema";

export type AnalyticsSummaryPoint = {
  day: string;
  // Null on a day the pipeline never extracted: unknown, not zero.
  active: number | null;
  // Actives narrowed to the DB event sources — did something, not just opened
  // the app.
  working: number | null;
  signups: number;
  totalRegistered: number;
  proDollars: number;
  topupDollars: number;
};

export type AnalyticsSummary = {
  generatedAt: string;
  points: AnalyticsSummaryPoint[];
  registered: number;
  signups7d: number;
  signupsWindow: number;
  activeYesterday: number | null;
  active7d: number | null;
  // Active last 7 days against the prior 7; null without a baseline.
  weekDeltaPercent: number | null;
  subscribers: number | null;
  canceling: number | null;
  funded: number | null;
  fundedDollars: number | null;
  // Paid charges across the window; null when the rollup predates billing.
  revenueDollars: number | null;
  missingDayCount: number;
};

function dollars(micros: string): number {
  return Number(micros) / 1e6;
}

export function summarizeRollup(rollup: AnalyticsRollup): AnalyticsSummary {
  // Any source bit marks a day active; the DB sources mark it working.
  const workBits = rollup.sources.reduce(
    (mask, source, i) => (source === "posthog" ? mask : mask | (1 << i)),
    0,
  );
  const missingDays = new Set(rollup.missing.map((entry) => entry.day));

  const signupsByDay = new Map<string, number>();
  for (const user of rollup.users) {
    const day = user.registeredAt.slice(0, 10);
    signupsByDay.set(day, (signupsByDay.get(day) ?? 0) + 1);
  }

  // Cumulative registrations start from everyone who signed up before the
  // window, so the total line carries the real base.
  const firstDay = rollup.days[0] ?? "";
  let totalRegistered = rollup.users.filter(
    (user) => user.registeredAt.slice(0, 10) < firstDay,
  ).length;

  const points: AnalyticsSummaryPoint[] = [];
  for (const [i, day] of rollup.days.entries()) {
    const signups = signupsByDay.get(day) ?? 0;
    totalRegistered += signups;
    let active: number | null = null;
    let working: number | null = null;
    if (!missingDays.has(day)) {
      let visited = 0;
      let worked = 0;
      for (const user of rollup.users) {
        const mask = user.activity[i] ?? 0;
        if (mask !== 0) visited += 1;
        if ((mask & workBits) !== 0) worked += 1;
      }
      active = visited;
      working = worked;
    }
    const revenue = rollup.billing?.revenue[i];
    points.push({
      day,
      active,
      working,
      signups,
      totalRegistered,
      proDollars: dollars(revenue?.proMicros ?? "0"),
      topupDollars: dollars(revenue?.topupMicros ?? "0"),
    });
  }

  // Counts users active on any known day in the range; null when the whole
  // range went unextracted.
  const activeInRange = (from: number, to: number): number | null => {
    const known: number[] = [];
    for (let i = Math.max(0, from); i < Math.max(0, to); i++) {
      if (!missingDays.has(rollup.days[i])) known.push(i);
    }
    if (known.length === 0) return null;
    return rollup.users.filter((user) =>
      known.some((i) => (user.activity[i] ?? 0) !== 0),
    ).length;
  };

  const len = rollup.days.length;
  const active7d = activeInRange(len - 7, len);
  const activePrior7d = activeInRange(len - 14, len - 7);
  const billing = rollup.billing;

  return {
    generatedAt: rollup.generatedAt,
    points,
    registered: rollup.users.length,
    signups7d: rollup.days
      .slice(-7)
      .reduce((sum, day) => sum + (signupsByDay.get(day) ?? 0), 0),
    signupsWindow: points.reduce((sum, point) => sum + point.signups, 0),
    activeYesterday: points[points.length - 1]?.active ?? null,
    active7d,
    weekDeltaPercent:
      active7d !== null && activePrior7d !== null && activePrior7d > 0
        ? ((active7d - activePrior7d) / activePrior7d) * 100
        : null,
    subscribers: billing?.subscribers ?? null,
    canceling: billing?.canceling ?? null,
    funded: billing?.funded ?? null,
    fundedDollars: billing ? dollars(billing.fundedMicros) : null,
    revenueDollars: billing
      ? points.reduce((sum, point) => sum + point.proDollars + point.topupDollars, 0)
      : null,
    missingDayCount: missingDays.size,
  };
}
