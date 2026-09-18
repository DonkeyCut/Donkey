// How the user list is ordered, and the per-user numbers that ordering needs.
// It runs on the server so a dashboard reads a page of people instead of the
// whole account table.
import { workBitsOf } from "@/lib/analytics/summarize";
import type { AnalyticsRollup, AnalyticsRollupUser } from "@/lib/analytics/schema";

// Ranking weight decays with age — a working day two weeks back counts half of
// yesterday's — so the list leads with who is active now. A day the user only
// visited counts a fraction of one they worked.
const HALF_LIFE_DAYS = 14;
const VISIT_WEIGHT = 0.35;

/** How many accounts one page carries. The server owns it: a client asks for
 * the first page, then follows `nextCursor` until it is null. */
export const USERS_PAGE_SIZE = 50;

export const USER_SORTS = [
  { id: "active", label: "Most active" },
  { id: "recent", label: "Recently active" },
  { id: "joined", label: "Newest" },
  { id: "paid", label: "Top paid" },
] as const;
export type UserSort = (typeof USER_SORTS)[number]["id"];

export type RankedUser = AnalyticsRollupUser & {
  score: number;
  activeDays: number;
  /** Index into the rollup's days of the last day with any activity; -1 for never. */
  lastActive: number;
};

/** One page of ranked accounts, as /api/analytics/users answers it. Ranks
 * hold only within one rollup, so a caller keys its pages on `generatedAt`. */
export type AnalyticsUsersPage = {
  generatedAt: string;
  users: RankedUser[];
  total: number;
  nextCursor: number | null;
  /** The orders this API ranks by, so every client offers the same ones. */
  sorts: readonly { id: UserSort; label: string }[];
  pageSize: number;
};

export function rankUsers(rollup: AnalyticsRollup, sort: UserSort): RankedUser[] {
  const workBits = workBitsOf(rollup.sources);
  const len = rollup.days.length;
  const ranked = rollup.users.map((user) => {
    let score = 0;
    let activeDays = 0;
    let lastActive = -1;
    for (let i = 0; i < len; i++) {
      const mask = user.activity[i] ?? 0;
      if (mask === 0) continue;
      activeDays++;
      lastActive = i;
      score +=
        ((mask & workBits) !== 0 ? 1 : VISIT_WEIGHT) * 0.5 ** ((len - 1 - i) / HALF_LIFE_DAYS);
    }
    return { ...user, activeDays, lastActive, score };
  });
  const funded = (user: RankedUser) => Number(user.fundedMicros ?? "0");
  const by: Record<UserSort, (a: RankedUser, b: RankedUser) => number> = {
    active: (a, b) => b.score - a.score,
    joined: (a, b) => (a.registeredAt < b.registeredAt ? 1 : -1),
    paid: (a, b) => funded(b) - funded(a) || b.score - a.score,
    recent: (a, b) => b.lastActive - a.lastActive || b.score - a.score,
  };
  // Our own accounts sink to the bottom under every sort: they are active
  // every day and would otherwise own the top of the list.
  return ranked.sort(
    (a, b) => Number(a.superUser === true) - Number(b.superUser === true) || by[sort](a, b),
  );
}
