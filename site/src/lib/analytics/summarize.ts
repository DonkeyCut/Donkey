// The rollup folded to what a dashboard draws: one point per day plus the
// headline numbers. Pure, and the only place those numbers are computed — the
// su charts and the phone both read the result, so neither walks the user
// list to draw a line.
import type { AnalyticsRollup } from "@/lib/analytics/schema";

/** Activity is null for a day the pipeline never extracted: nothing was read,
 * which is not the same as a day nobody worked. Signups come from the user
 * snapshot, so they are always known. */
export type AnalyticsDayPoint = {
  day: string;
  active: number | null;
  working: number | null;
  signups: number;
  totalRegistered: number;
};

export type AnalyticsSummary = {
  version: number;
  generatedAt: string;
  /** Oldest → newest. */
  days: string[];
  /** Bit order of the activity masks the users page carries. */
  sources: string[];
  /** Days the consolidation could not read. */
  missing: string[];
  series: AnalyticsDayPoint[];
  registered: number;
  signups7d: number;
  signupsWindow: number;
  activeYesterday: number | null;
  active7d: number | null;
  activePrior7d: number | null;
  /** Credit held across every account, BigInt micros as a decimal string. */
  balanceMicros: string;
  billing?: AnalyticsRollup["billing"];
  referrals?: AnalyticsRollup["referrals"];
};

/** The mask bits that mean the person did something, not just opened the app. */
export function workBitsOf(sources: string[]): number {
  return sources.reduce((mask, source, i) => (source === "posthog" ? mask : mask | (1 << i)), 0);
}

export function summarizeRollup(rollup: AnalyticsRollup): AnalyticsSummary {
  const workBits = workBitsOf(rollup.sources);
  const missing = rollup.missing.map((entry) => entry.day);
  const missingDays = new Set(missing);

  const signupsByDay = new Map<string, number>();
  for (const user of rollup.users) {
    const day = user.registeredAt.slice(0, 10);
    signupsByDay.set(day, (signupsByDay.get(day) ?? 0) + 1);
  }

  // Cumulative registrations start from everyone who signed up before the
  // window, so the total line carries the real base, not zero.
  const firstDay = rollup.days[0] ?? "";
  let totalRegistered = rollup.users.filter(
    (user) => user.registeredAt.slice(0, 10) < firstDay,
  ).length;

  const series = rollup.days.map((day, i) => {
    const signups = signupsByDay.get(day) ?? 0;
    totalRegistered += signups;
    if (missingDays.has(day)) {
      return { active: null, day, signups, totalRegistered, working: null };
    }
    let active = 0;
    let working = 0;
    for (const user of rollup.users) {
      const mask = user.activity[i] ?? 0;
      if (mask !== 0) active++;
      if ((mask & workBits) !== 0) working++;
    }
    return { active, day, signups, totalRegistered, working };
  });

  // Null when the whole range went unextracted; otherwise it counts over the
  // days there is data for, so one missing day doesn't drag the number down.
  const activeInRange = (from: number, to: number): number | null => {
    const known: number[] = [];
    for (let i = Math.max(0, from); i < to; i++) {
      if (!missingDays.has(rollup.days[i])) known.push(i);
    }
    if (known.length === 0) return null;
    let count = 0;
    for (const user of rollup.users) {
      if (known.some((i) => (user.activity[i] ?? 0) !== 0)) count++;
    }
    return count;
  };

  const len = rollup.days.length;
  return {
    active7d: activeInRange(len - 7, len),
    activePrior7d: activeInRange(len - 14, len - 7),
    activeYesterday: series[len - 1]?.active ?? null,
    balanceMicros: rollup.users
      .reduce((sum, user) => sum + BigInt(user.balanceMicros), BigInt(0))
      .toString(),
    billing: rollup.billing,
    days: rollup.days,
    generatedAt: rollup.generatedAt,
    missing,
    referrals: rollup.referrals,
    registered: rollup.users.length,
    series,
    signups7d: rollup.days.slice(-7).reduce((sum, day) => sum + (signupsByDay.get(day) ?? 0), 0),
    signupsWindow: series.reduce((sum, point) => sum + point.signups, 0),
    sources: rollup.sources,
    version: rollup.version,
  };
}
