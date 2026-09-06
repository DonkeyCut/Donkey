"use client";

import { ArrowUpRight } from "lucide-react";
import { useMemo, useRef } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type {
  AnalyticsBilling,
  AnalyticsReferrals,
  AnalyticsRollup,
  AnalyticsRollupUser,
} from "@/lib/analytics/schema";
import { REFERRAL_SOURCES } from "@/lib/onboarding/sequence";
import { useLocalPref } from "@/cut/lib/uiState";
import { cn } from "@/lib/utils";
import { DragBlock, useReorder } from "@/app/su/analytics/Reorder";
import { SuStandIn } from "@/app/su/SuStandIn";
import { useRowWindow } from "@/app/su/analytics/rowWindow";
import { useAnalyticsRollup } from "@/queries/analytics";
import { ApiError } from "@/queries/apiClient";

// Everything here renders the nightly rollup (analytics/rollup.json via
// /api/analytics/rollup) — stale until the next job run by design. "Active" is
// any source bit for the day; "working" narrows to the DB event sources, i.e.
// the user did something beyond opening the app.

// Formatting a day goes through the locale machinery, which is slow enough
// that a label per grid cell held the page for over a second. The rollup
// names a few hundred distinct days, so each is formatted once.
const dayLabels = new Map<string, string>();
function formatDay(iso: string): string {
  let label = dayLabels.get(iso);
  if (label === undefined) {
    label = new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    dayLabels.set(iso, label);
  }
  return label;
}

const dollars = (micros: bigint | string) => Number(micros) / 1e6;
const formatDollars = (value: number) =>
  `${value < 0 ? "-" : ""}$${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const formatMicros = (micros: bigint | string) => formatDollars(dollars(micros));

function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

// Storage colored by how close the account sits to its quota: orange from
// 80% up, red at or past the ceiling. Unlimited accounts stay neutral.
function storageTone(bytes: number, quotaBytes: number | null | undefined): string {
  if (quotaBytes === null || quotaBytes === undefined || quotaBytes <= 0) return "";
  const ratio = bytes / quotaBytes;
  if (ratio >= 1) return "text-red-600 dark:text-red-500";
  if (ratio >= 0.8) return "text-orange-600 dark:text-orange-400";
  return "";
}

// Activity is null for a day the pipeline never extracted: the masks are
// empty because there was nothing to read, which is not the same as a day
// nobody worked. Those days leave a gap in the charts and an unknown dot in
// the grid. Signups come from the user snapshot, so they are always known.
type DayPoint = {
  day: string;
  active: number | null;
  working: number | null;
  signups: number;
  totalRegistered: number;
};

type RollupView = {
  series: DayPoint[];
  workBits: number;
  missingDays: Set<string>;
  registered: number;
  signups7d: number;
  signupsWindow: number;
  activeYesterday: number | null;
  active7d: number | null;
  activePrior7d: number | null;
  totalBalanceMicros: bigint;
};

function deriveView(rollup: AnalyticsRollup): RollupView {
  const workBits = rollup.sources.reduce(
    (mask, source, i) => (source === "posthog" ? mask : mask | (1 << i)),
    0,
  );

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

  // Any day the consolidation could not read a source for is undercounted at
  // best, and indistinguishable from a quiet day — so it reports as unknown
  // rather than as a number the reader would trust.
  const missingDays = new Set(rollup.missing.map((entry) => entry.day));

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
  const last7 = rollup.days.slice(-7);
  return {
    active7d: activeInRange(len - 7, len),
    activePrior7d: activeInRange(len - 14, len - 7),
    activeYesterday: series[len - 1]?.active ?? null,
    missingDays,
    registered: rollup.users.length,
    series,
    signups7d: last7.reduce((sum, day) => sum + (signupsByDay.get(day) ?? 0), 0),
    signupsWindow: series.reduce((sum, point) => sum + point.signups, 0),
    totalBalanceMicros: rollup.users.reduce((sum, u) => sum + BigInt(u.balanceMicros), BigInt(0)),
    workBits,
  };
}

// One chart point per day, twice over: `series` holds the per-source answer
// counts of that day (the stacked bars), `cumulative` the running totals per
// source plus the running total of users who answered (the trend lines).
type ReferralView = {
  config: ChartConfig;
  trendConfig: ChartConfig;
  series: Record<string, number | string | string[]>[];
  cumulative: Record<string, number | string>[];
  respondents: number;
};

function deriveReferrals(referrals: AnalyticsReferrals): ReferralView {
  const labels = new Map<string, string>(REFERRAL_SOURCES.map((s) => [s.id, s.label]));
  // Sources render in the survey's own order (the rollup stores its own);
  // anything the survey no longer asks about trails the list.
  const surveyIds = REFERRAL_SOURCES.map((s) => s.id as string);
  const ordered = [
    ...surveyIds.filter((id) => referrals.sources.includes(id)),
    ...referrals.sources.filter((id) => !surveyIds.includes(id)),
  ];
  const config: ChartConfig = {};
  ordered.forEach((id, i) => {
    config[id] = {
      color: `var(--chart-${Math.min(i + 1, 8)})`,
      label: labels.get(id) ?? id,
    };
  });
  // The total rides with the source lines but is an aggregate, so it wears
  // neutral ink where every source keeps its own hue.
  const trendConfig: ChartConfig = {
    totalResponses: { color: "var(--muted-foreground)", label: "Total" },
    ...config,
  };
  let respondents = 0;
  const running = new Map<string, number>();
  const series: Record<string, number | string | string[]>[] = [];
  const cumulative: Record<string, number | string>[] = [];
  for (const entry of referrals.days) {
    respondents += entry.respondents;
    const daily: Record<string, number | string | string[]> = {
      day: entry.day,
      otherAnswers: entry.others,
    };
    const total: Record<string, number | string> = { day: entry.day, totalResponses: respondents };
    referrals.sources.forEach((id, i) => {
      daily[id] = entry.counts[i] ?? 0;
      running.set(id, (running.get(id) ?? 0) + (entry.counts[i] ?? 0));
      total[id] = running.get(id) ?? 0;
    });
    series.push(daily);
    cumulative.push(total);
  }
  return { config, cumulative, respondents, series, trendConfig };
}

type TooltipPayload = NonNullable<React.ComponentProps<typeof ChartTooltipContent>["payload"]>;

const sumOf = (payload: TooltipPayload) =>
  payload.reduce((sum, item) => sum + (typeof item.value === "number" ? item.value : 0), 0);

/** The shared tooltip with the day's total on the date row. On a chart with
 * several series a zero row says nothing, so those drop out; `total` picks
 * the headline number (the sum of what shows, unless told otherwise). */
function TotalTooltipContent({
  format = (n) => n.toLocaleString("en-US"),
  total = sumOf,
  ...props
}: React.ComponentProps<typeof ChartTooltipContent> & {
  format?: (total: number) => string;
  total?: (payload: TooltipPayload) => number;
}) {
  const shown =
    props.payload && props.payload.length > 1
      ? props.payload.filter((item) => item.value !== 0)
      : props.payload;
  return (
    <ChartTooltipContent
      {...props}
      payload={shown?.length ? shown : props.payload}
      labelFormatter={(label, payload) => (
        <div className="flex items-center justify-between gap-4">
          <span>{formatDay(String(label))}</span>
          <span className="font-mono tabular-nums">{format(total(payload))}</span>
        </div>
      )}
    />
  );
}

// A day's "other" answers run to dozens, and the same place is typed over and
// over. The list is grouped by what was written and bounded to the rows that
// fit inside the chart's own box; the rest is counted.
const OTHER_ANSWERS_SHOWN = 6;

function groupOtherAnswers(answers: string[]): { label: string; count: number }[] {
  const groups = new Map<string, { label: string; count: number }>();
  for (const answer of answers) {
    const label = answer.trim();
    if (!label) continue;
    const key = label.toLowerCase();
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { count: 1, label });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/** One tooltip row: swatch, label, value. */
function TooltipRow({
  color,
  label,
  value,
}: {
  color: string | undefined;
  label: React.ReactNode;
  value: string;
}) {
  return (
    <>
      <div className="size-2.5 shrink-0 rounded-[2px]" style={{ background: color }} />
      <div className="flex flex-1 items-center justify-between gap-3 leading-none">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono font-medium text-foreground tabular-nums">{value}</span>
      </div>
    </>
  );
}

/** The sources tooltip, which carries what "Other" meant: the day's free-text
 * answers hang under that row as an indented bulleted list. */
function SourcesTooltipContent({
  config,
  ...props
}: React.ComponentProps<typeof ChartTooltipContent> & { config: ChartConfig }) {
  return (
    <TotalTooltipContent
      {...props}
      formatter={(value, name, item) => {
        const id = String(name);
        const answers = groupOtherAnswers(
          (item.payload as { otherAnswers?: string[] } | undefined)?.otherAnswers ?? [],
        );
        return (
          <>
            <TooltipRow
              color={item.color}
              label={config[id]?.label ?? id}
              value={typeof value === "number" ? value.toLocaleString() : String(value)}
            />
            {id === "other" && answers.length ? (
              <ul className="-mt-1 ml-[1.125rem] w-full list-disc space-y-0.5 pl-3 text-muted-foreground marker:text-muted-foreground/60">
                {answers.slice(0, OTHER_ANSWERS_SHOWN).map((answer) => (
                  <li key={answer.label} className="break-words">
                    {answer.label}
                    {answer.count > 1 ? (
                      <span className="text-muted-foreground/70"> ×{answer.count}</span>
                    ) : null}
                  </li>
                ))}
                {answers.length > OTHER_ANSWERS_SHOWN ? (
                  <li className="list-none text-muted-foreground/70">
                    +{answers.length - OTHER_ANSWERS_SHOWN} more
                  </li>
                ) : null}
              </ul>
            ) : null}
          </>
        );
      }}
    />
  );
}

const activesConfig = {
  active: { label: "Active", color: "var(--chart-1)" },
  working: { label: "Working", color: "var(--chart-2)" },
} satisfies ChartConfig;

const signupsConfig = {
  signups: { label: "Signups", color: "var(--chart-1)" },
} satisfies ChartConfig;

const totalRegisteredConfig = {
  totalRegistered: { label: "Total registered", color: "var(--chart-1)" },
} satisfies ChartConfig;

// Paid money in the series hues; refunds in their own hue below the
// baseline; declined attempts in faded neutral ink, since they are a state
// and never revenue. Cancel requests are the status red, which no bar uses.
const revenueConfig = {
  pro: { label: "Pro", color: "var(--chart-1)" },
  topups: { label: "Top-ups", color: "var(--chart-2)" },
  other: { label: "Other", color: "var(--chart-3)" },
  refunds: { label: "Refunded", color: "var(--chart-5)" },
  declined: { label: "Declined", color: "color-mix(in oklab, var(--muted-foreground) 45%, transparent)" },
} satisfies ChartConfig;

type RevenuePoint = {
  day: string;
  pro: number;
  topups: number;
  // Paid charges the pull could tie to neither Pro nor a credit purchase.
  other: number;
  // Negative, so the bar hangs under the baseline.
  refunds: number;
  declined: number;
  cancels: number;
};

// Per-day dollars from the billing section's micro strings, on its own
// window (it ends today; the activity window ends yesterday).
function deriveRevenue(billing: AnalyticsBilling): RevenuePoint[] {
  return billing.days.map((day, i) => {
    const entry = billing.revenue[i];
    return {
      cancels: entry?.cancels ?? 0,
      day,
      declined: dollars(entry?.declinedMicros ?? "0"),
      other: dollars(entry?.otherMicros ?? "0"),
      pro: dollars(entry?.proMicros ?? "0"),
      refunds: -dollars(entry?.refundedMicros ?? "0"),
      topups: dollars(entry?.topupMicros ?? "0"),
    };
  });
}

const netOf = (point: Pick<RevenuePoint, "pro" | "topups" | "other" | "refunds">) =>
  point.pro + point.topups + point.other + point.refunds;

type BillingEvent = AnalyticsBilling["events"][number];

/** Where a canceled subscription stands now: still running until its end
 * date, or already stopped. */
function cancelStatus(event: BillingEvent): string {
  const day = event.endsAt ? formatDay(event.endsAt.slice(0, 10)) : null;
  if (event.ended) return day ? `ended ${day}` : "ended";
  return day ? `ends ${day}` : "ending";
}

/** An × on a day with cancel requests, centered in the plot's height. Drawn
 * as the label of an invisible reference line, whose box is the plot's full
 * height at that day's x. It sits inside the plot, so hovering it raises the
 * day's tooltip like any bar, and it takes no pointer events or selection of
 * its own. A halo in the card color keeps it legible over a bar. */
function CancelMarker({ viewBox }: { viewBox?: { x: number; y: number; height: number } }) {
  if (!viewBox) return null;
  const cx = viewBox.x;
  const cy = viewBox.y + viewBox.height / 2;
  const r = 3.5;
  const d = `M${cx - r} ${cy - r}L${cx + r} ${cy + r}M${cx + r} ${cy - r}L${cx - r} ${cy + r}`;
  return (
    <g pointerEvents="none" style={{ userSelect: "none" }} aria-hidden>
      <path d={d} fill="none" stroke="var(--card)" strokeLinecap="round" strokeWidth={4.5} />
      <path d={d} fill="none" stroke="var(--destructive)" strokeLinecap="round" strokeWidth={2} />
    </g>
  );
}

/** The revenue tooltip: net on the date row, the day's money rows, and the
 * cancel requests made that day: who, where the subscription stands now,
 * and what the person said on the way out. */
function RevenueTooltipContent({
  events,
  ...props
}: React.ComponentProps<typeof ChartTooltipContent> & { events: AnalyticsBilling["events"] }) {
  const point = props.payload?.[0]?.payload as RevenuePoint | undefined;
  const cancels = point ? events.filter((e) => e.kind === "canceled" && e.day === point.day) : [];
  return (
    <div className="grid gap-1.5">
      <TotalTooltipContent
        {...props}
        className="max-w-80"
        format={formatDollars}
        total={() => (point ? netOf(point) : 0)}
        formatter={(value, name, item) => (
          <TooltipRow
            color={item.color}
            label={revenueConfig[name as keyof typeof revenueConfig]?.label ?? String(name)}
            value={formatDollars(typeof value === "number" ? value : 0)}
          />
        )}
      />
      {cancels.length > 0 && (
        <div className="max-w-80 space-y-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
          {cancels.map((event) => (
            <div key={event.objectId ?? event.email ?? event.day}>
              <p className="flex items-center justify-between gap-3">
                <span className="font-medium text-destructive">canceled</span>
                <span className="font-medium text-foreground">{cancelStatus(event)}</span>
              </p>
              <p className="text-muted-foreground">{event.email ?? "unknown customer"}</p>
              {event.detail && (
                <p className="line-clamp-3 text-muted-foreground">{event.detail}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Stripe dashboard destinations for the billing figures.
const stripeLinks = (base: string) => ({
  canceled: `${base}/subscriptions?status=canceled`,
  declined: `${base}/payments?status%5B%5D=failed`,
  paid: `${base}/payments?status%5B%5D=successful`,
  payment: (id: string) => `${base}/payments/${id}`,
  refunded: `${base}/payments?status%5B%5D=refunded`,
  subscribers: `${base}/subscriptions?status=active`,
  subscription: (id: string) => `${base}/subscriptions/${id}`,
});

function StripeLink({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "inline-flex items-center gap-0.5 underline-offset-4 hover:text-foreground hover:underline",
        className,
      )}
    >
      {children}
      <ArrowUpRight className="size-3 shrink-0" aria-hidden />
    </a>
  );
}

// The most recent declines and cancel requests shown under the chart; the
// rest sit behind the Stripe link.
const BILLING_EVENTS_SHOWN = 6;

// The dashboard blocks in their default order. The ids are the saved-layout
// contract: renaming one drops that block back to its default position.
const TILE_IDS = [
  "registered",
  "activeYesterday",
  "active7d",
  "balance",
  "pro",
  "funded",
  "churn",
  "declined",
] as const;
const CARD_IDS = [
  "actives",
  "signups",
  "referralSources",
  "referralResponses",
  "revenue",
  "totalRegistered",
] as const;
type TileId = (typeof TILE_IDS)[number];
type CardId = (typeof CARD_IDS)[number];

function StatTile({
  label,
  value,
  sub,
  href,
}: {
  label: string;
  value: string;
  sub: React.ReactNode;
  // Where the figure lives in Stripe; the label becomes the link.
  href?: string;
}) {
  return (
    <div className="rounded-xl border bg-card p-5">
      <p className="text-sm text-muted-foreground">
        {href ? <StripeLink href={href}>{label}</StripeLink> : label}
      </p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  className,
  children,
}: {
  title: string;
  subtitle: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("min-w-0 overflow-hidden rounded-xl border bg-card p-5", className)}>
      <p className="font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{subtitle}</p>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function ActivityDot({
  mask,
  workBits,
  unknown,
}: {
  mask: number;
  workBits: number;
  unknown: boolean;
}) {
  const worked = (mask & workBits) !== 0;
  const visited = mask !== 0;
  return (
    <span
      className={cn(
        "block size-2 rounded-full",
        unknown
          ? "border border-dashed border-muted-foreground/50"
          : worked
            ? "bg-[var(--chart-1)]"
            : visited
              ? "bg-[var(--chart-1)] opacity-40"
              : "bg-muted",
      )}
    />
  );
}

// Ranking weight decays with age — a working day two weeks back counts half
// of yesterday's — so the list leads with who is active now. A day the user
// only visited counts a fraction of one they worked.
const HALF_LIFE_DAYS = 14;
const VISIT_WEIGHT = 0.35;

const USER_SORTS = [
  { id: "active", label: "Most active" },
  { id: "recent", label: "Recently active" },
  { id: "joined", label: "Newest" },
  { id: "paid", label: "Top paid" },
] as const;
type UserSort = (typeof USER_SORTS)[number]["id"];

type RankedUser = AnalyticsRollupUser & {
  score: number;
  activeDays: number;
  /** Index into rollup.days of the last day with any activity; -1 for never. */
  lastActive: number;
};

function rankUsers(rollup: AnalyticsRollup, workBits: number, sort: UserSort): RankedUser[] {
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

function ActivityGrid({
  rollup,
  workBits,
  missingDays,
}: {
  rollup: AnalyticsRollup;
  workBits: number;
  missingDays: Set<string>;
}) {
  const [sort, setSort] = useLocalPref<UserSort>(
    "su-analytics-user-sort",
    "active",
    (v) => USER_SORTS.some((option) => option.id === v),
  );
  const users = useMemo(() => rankUsers(rollup, workBits, sort), [rollup, workBits, sort]);
  const body = useRef<HTMLTableSectionElement>(null);
  const rows = useRowWindow(users.length, body);

  // Newest day sits in the leftmost column so the current dots are in view
  // before any horizontal scroll; each column keeps its index into the
  // activity masks.
  const columns = useMemo(
    () => rollup.days.map((day, i) => ({ day, i, unknown: missingDays.has(day) })).reverse(),
    [rollup.days, missingDays],
  );
  const columnCount = columns.length + 1;

  // A dot's tooltip is built when the pointer reaches it. Building one per
  // cell up front was the bulk of the page's arrival cost.
  const describeDot = (event: React.PointerEvent<HTMLTableSectionElement>) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-dot]");
    if (!cell || cell.title) return;
    const user = users[Number(cell.dataset.user)];
    const column = columns[Number(cell.dataset.col)];
    if (!user || !column) return;
    const mask = user.activity[column.i] ?? 0;
    const when = formatDay(column.day);
    cell.title = column.unknown
      ? `${user.email} — ${when}: no data`
      : mask === 0
        ? `${user.email} — ${when}: inactive`
        : `${user.email} — ${when}: ${rollup.sources.filter((_, i) => (mask & (1 << i)) !== 0).join(", ")}`;
  };

  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium">User activity</p>
          <p className="text-sm text-muted-foreground">
            One dot per user per day, last {rollup.days.length} days
            {missingDays.size > 0 && ` · ${missingDays.size} without data`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {USER_SORTS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={sort === option.id}
              onClick={() => setSort(option.id)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs transition-colors",
                sort === option.id
                  ? "border-border bg-muted"
                  : "border-transparent text-muted-foreground hover:bg-muted/60",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="border-separate border-spacing-0">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-card" />
              {columns.map(({ day }, col) => (
                <th
                  key={day}
                  className="pb-2 text-left text-[10px] font-normal whitespace-nowrap text-muted-foreground"
                >
                  {col === 0 || day.endsWith("-01") ? formatDay(day) : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody ref={body} onPointerOver={describeDot}>
            {rows.above > 0 && (
              <tr aria-hidden>
                <td colSpan={columnCount} className="p-0" style={{ height: rows.above }} />
              </tr>
            )}
            {users.slice(rows.start, rows.end).map((user, offset) => {
              const index = rows.start + offset;
              return (
                <tr key={user.id} data-row="">
                  <td className="sticky left-0 z-10 bg-card py-1 pr-4 whitespace-nowrap">
                    <span className="flex items-center gap-1.5">
                      <span className="block max-w-56 truncate text-sm" title={user.name}>
                        {user.email}
                      </span>
                      {user.superUser === true && (
                        <span className="rounded-sm bg-muted px-1 text-[10px] text-muted-foreground">
                          su
                        </span>
                      )}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {user.activeDays === 0
                        ? "no activity"
                        : `${user.activeDays} active ${user.activeDays === 1 ? "day" : "days"} · last ${formatDay(rollup.days[user.lastActive])}`}{" "}
                      · joined {formatDay(user.registeredAt.slice(0, 10))} ·{" "}
                      {formatMicros(user.balanceMicros)}
                      {user.fundedMicros !== undefined && (
                        <span className="text-emerald-700 dark:text-emerald-500">
                          {" "}
                          · paid {formatMicros(user.fundedMicros)}
                        </span>
                      )}
                      {user.storageBytes !== undefined && (
                        <span
                          className={storageTone(Number(user.storageBytes), user.storageQuotaBytes)}
                          title={
                            user.storageQuotaBytes == null
                              ? "unlimited storage"
                              : `of ${formatGb(user.storageQuotaBytes)}`
                          }
                        >
                          {" "}
                          · {formatGb(Number(user.storageBytes))}
                        </span>
                      )}
                    </span>
                  </td>
                  {columns.map(({ day, i, unknown }, col) => (
                    <td key={day} className="p-0.5" data-dot data-user={index} data-col={col}>
                      <ActivityDot
                        mask={user.activity[i] ?? 0}
                        unknown={unknown}
                        workBits={workBits}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
            {rows.below > 0 && (
              <tr aria-hidden>
                <td colSpan={columnCount} className="p-0" style={{ height: rows.below }} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-[var(--chart-1)]" /> worked
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-[var(--chart-1)] opacity-40" /> visited only
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-muted" /> inactive
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full border border-dashed border-muted-foreground/50" /> no
          data
        </span>
      </p>
    </div>
  );
}

export default function SuAnalyticsPage() {
  const rollup = useAnalyticsRollup();
  const view = useMemo(
    () => (rollup.data ? deriveView(rollup.data) : null),
    [rollup.data],
  );
  const referrals = useMemo(
    () => (rollup.data?.referrals ? deriveReferrals(rollup.data.referrals) : null),
    [rollup.data],
  );
  const billingSection = rollup.data?.billing;
  const revenue = useMemo(
    () => (billingSection && "days" in billingSection ? deriveRevenue(billingSection) : null),
    [billingSection],
  );
  // Trend lines toggled off stay off across visits.
  const [hiddenTrends, setHiddenTrends] = useLocalPref<string[]>(
    "su-referral-hidden-trends",
    [],
    (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
  );
  // The layout is the reader's: every tile and card drags into any order, and
  // the arrangement sticks per browser. The user grid stays pinned last.
  const tiles = useReorder("su-analytics-tile-order", TILE_IDS);
  const cards = useReorder("su-analytics-card-order", CARD_IDS);

  if (rollup.isPending) return <SuStandIn />;

  if (rollup.error || !view || !rollup.data) {
    const noData = rollup.error instanceof ApiError && rollup.error.status === 404;
    return (
      <div className="rounded-xl border bg-card p-5 text-sm text-muted-foreground">
        {noData
          ? "No data yet — the nightly analytics job hasn't produced a rollup. Run the analytics-daily job and refresh."
          : "Couldn't load analytics."}
      </div>
    );
  }

  const data = rollup.data;
  const deltaPct =
    view.active7d !== null && view.activePrior7d !== null && view.activePrior7d > 0
      ? `${(((view.active7d - view.activePrior7d) / view.activePrior7d) * 100).toFixed(1)}%`
      : null;
  const count = (n: number | null) => (n === null ? "—" : n.toLocaleString("en-US"));
  const lastDay = data.days[data.days.length - 1];
  // Billing is absent from rollups written before it shipped (or before it
  // took this shape); the next run fills it in.
  const billing = data.billing && "days" in data.billing ? data.billing : undefined;
  const churnBase = billing ? billing.subscribers + billing.churned : 0;
  const staleBilling = "not in this rollup yet — run analytics";
  const links = billing ? stripeLinks(billing.dashboardUrl) : undefined;
  const nextCancel = billing?.canceling[0];

  const tileNodes: Record<TileId, React.ReactNode> = {
    registered: (
      <StatTile
        label="Registered users"
        value={view.registered.toLocaleString("en-US")}
        sub={`+${view.signups7d} in the last 7 days`}
      />
    ),
    activeYesterday: (
      <StatTile
        label="Active yesterday"
        value={count(view.activeYesterday)}
        sub={
          view.activeYesterday === null
            ? `no extract for ${formatDay(lastDay)} yet`
            : `of ${view.registered.toLocaleString("en-US")} registered`
        }
      />
    ),
    active7d: (
      <StatTile
        label="Active last 7 days"
        value={count(view.active7d)}
        sub={
          view.active7d === null ? (
            "no extracts for the last 7 days"
          ) : deltaPct === null ? (
            "no prior-week baseline"
          ) : (
            <>
              <span
                className={cn(
                  deltaPct.startsWith("-")
                    ? "text-destructive"
                    : "text-emerald-700 dark:text-emerald-500",
                )}
              >
                {deltaPct.startsWith("-") ? deltaPct : `+${deltaPct}`}
              </span>{" "}
              vs prior 7 days
            </>
          )
        }
      />
    ),
    balance: (
      <StatTile
        label="Outstanding balance"
        value={formatMicros(view.totalBalanceMicros)}
        sub="credits across all accounts"
      />
    ),
    pro: (
      <StatTile
        label="Pro subscribers"
        value={billing ? billing.subscribers.toLocaleString("en-US") : "—"}
        href={links?.subscribers}
        sub={
          !billing ? (
            staleBilling
          ) : billing.canceling.length === 0 ? (
            "none canceling"
          ) : (
            <StripeLink
              href={
                nextCancel && billing.canceling.length === 1
                  ? `${billing.dashboardUrl}/subscriptions/${nextCancel.subscriptionId}`
                  : `${billing.dashboardUrl}/subscriptions?status=active`
              }
            >
              {billing.canceling.length} canceling
              {nextCancel?.endsAt ? ` · ends ${formatDay(nextCancel.endsAt.slice(0, 10))}` : ""}
            </StripeLink>
          )
        }
      />
    ),
    funded: (
      <StatTile
        label="People funded"
        value={billing ? billing.funded.toLocaleString("en-US") : "—"}
        href={links?.paid}
        sub={
          billing ? `${formatMicros(billing.fundedMicros)} paid all time` : staleBilling
        }
      />
    ),
    churn: (
      <StatTile
        label="Churn rate"
        value={
          billing && churnBase > 0
            ? `${((billing.churned / churnBase) * 100).toFixed(1)}%`
            : "—"
        }
        href={links?.canceled}
        sub={
          !billing
            ? staleBilling
            : churnBase === 0
              ? "no subscriptions yet"
              : `${billing.churned} of ${churnBase} subscriptions ended`
        }
      />
    ),
    declined: (
      <StatTile
        label="Tried to pay"
        value={billing ? billing.window.declinedCustomers.toLocaleString("en-US") : "—"}
        href={links?.declined}
        sub={
          billing
            ? `${formatMicros(billing.window.declinedMicros)} declined · ${billing.window.abandonedCheckouts} checkouts abandoned, last 60 days`
            : staleBilling
        }
      />
    ),
  };

  // Column spans belong to the grid's own children — the drag blocks — so a
  // card that should fill the row says so here rather than on the card inside
  // it, where `col-span` would have nothing to act on.
  const cardSpan: Partial<Record<CardId, string>> = {
    ...(revenue ? {} : { totalRegistered: "xl:col-span-2" }),
  };

  // A card the rollup can't fill stays out of the record; the saved order
  // skips it.
  const cardNodes: Partial<Record<CardId, React.ReactNode>> = {
    actives: (
      <ChartCard
        title="Active users"
        subtitle={
          view.missingDays.size > 0
            ? `Daily actives, last 60 days · ${view.missingDays.size} days without data are left blank`
            : "Daily actives, last 60 days"
        }
      >
        <ChartContainer className="w-full" config={activesConfig}>
          <AreaChart accessibilityLayer data={view.series} margin={{ left: -16 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              axisLine={false}
              dataKey="day"
              minTickGap={32}
              tickFormatter={formatDay}
              tickLine={false}
              tickMargin={8}
            />
            <YAxis allowDecimals={false} axisLine={false} tickLine={false} width={48} />
            <ChartTooltip
              content={
                <TotalTooltipContent
                  total={(payload) => {
                    const active = payload.find((item) => item.dataKey === "active");
                    return typeof active?.value === "number" ? active.value : 0;
                  }}
                />
              }
            />
            <Area
              dataKey="active"
              dot={false}
              fill="var(--color-active)"
              fillOpacity={0.1}
              stroke="var(--color-active)"
              strokeWidth={2}
              type="monotone"
            />
            <Area
              dataKey="working"
              dot={false}
              fill="var(--color-working)"
              fillOpacity={0.1}
              stroke="var(--color-working)"
              strokeWidth={2}
              type="monotone"
            />
            <ChartLegend content={<ChartLegendContent />} />
          </AreaChart>
        </ChartContainer>
      </ChartCard>
    ),
    signups: (
      <ChartCard
        title="Signups"
        subtitle={`New registrations per day · ${view.signupsWindow.toLocaleString("en-US")} in the last 60 days`}
      >
        <ChartContainer className="w-full" config={signupsConfig}>
          <BarChart accessibilityLayer data={view.series} margin={{ left: -16 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              axisLine={false}
              dataKey="day"
              minTickGap={32}
              tickFormatter={formatDay}
              tickLine={false}
              tickMargin={8}
            />
            <YAxis allowDecimals={false} axisLine={false} tickLine={false} width={48} />
            <ChartTooltip content={<TotalTooltipContent />} />
            <Bar
              dataKey="signups"
              fill="var(--color-signups)"
              maxBarSize={24}
              radius={[4, 4, 0, 0]}
            />
          </BarChart>
        </ChartContainer>
      </ChartCard>
    ),
    totalRegistered: (
      <ChartCard title="Total registered" subtitle="Cumulative registrations, last 60 days">
        <ChartContainer className="max-h-56 w-full" config={totalRegisteredConfig}>
          <AreaChart accessibilityLayer data={view.series} margin={{ left: -16 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              axisLine={false}
              dataKey="day"
              minTickGap={32}
              tickFormatter={formatDay}
              tickLine={false}
              tickMargin={8}
            />
            <YAxis
              allowDecimals={false}
              axisLine={false}
              domain={["auto", "auto"]}
              tickLine={false}
              width={48}
            />
            <ChartTooltip content={<TotalTooltipContent />} />
            <Area
              dataKey="totalRegistered"
              dot={false}
              fill="var(--color-totalRegistered)"
              fillOpacity={0.1}
              stroke="var(--color-totalRegistered)"
              strokeWidth={2}
              type="monotone"
            />
          </AreaChart>
        </ChartContainer>
      </ChartCard>
    ),
    ...(referrals
      ? {
          referralResponses: (
            <ChartCard
              title="Referral responses"
              subtitle={`Running totals by source · ${referrals.respondents.toLocaleString("en-US")} users answered all time`}
            >
              <ChartContainer className="w-full" config={referrals.trendConfig}>
                <LineChart accessibilityLayer data={referrals.cumulative} margin={{ left: -16 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    axisLine={false}
                    dataKey="day"
                    minTickGap={32}
                    tickFormatter={formatDay}
                    tickLine={false}
                    tickMargin={8}
                  />
                  <YAxis allowDecimals={false} axisLine={false} tickLine={false} width={48} />
                  <ChartTooltip
                    content={
                      <TotalTooltipContent
                        total={(payload) => {
                          const all = payload.find((item) => item.dataKey === "totalResponses");
                          return typeof all?.value === "number" ? all.value : 0;
                        }}
                      />
                    }
                  />
                  {Object.keys(referrals.trendConfig)
                    .filter((id) => !hiddenTrends.includes(id))
                    .map((id) => (
                      <Line
                        key={id}
                        dataKey={id}
                        dot={false}
                        stroke={`var(--color-${id})`}
                        strokeWidth={2}
                        type="monotone"
                      />
                    ))}
                </LineChart>
              </ChartContainer>
              {/* The legend doubles as the filter: a chip toggles its line, and
                  the choice sticks (localStorage). */}
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {Object.entries(referrals.trendConfig).map(([id, entry]) => {
                  const off = hiddenTrends.includes(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={!off}
                      title={off ? "Show" : "Hide"}
                      onClick={() =>
                        setHiddenTrends(
                          off ? hiddenTrends.filter((h) => h !== id) : [...hiddenTrends, id],
                        )
                      }
                      className={cn(
                        "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                        off
                          ? "border-transparent bg-muted text-muted-foreground"
                          : "border-border hover:bg-muted/60",
                      )}
                    >
                      <span
                        className={cn("size-2 rounded-full", off && "opacity-30")}
                        style={{ background: "color" in entry ? entry.color : undefined }}
                      />
                      {entry.label}
                    </button>
                  );
                })}
              </div>
            </ChartCard>
          ),
          referralSources: (
            <ChartCard
              title="Referral sources"
              subtitle="Onboarding answers per day, by source · one user can pick several"
            >
              <ChartContainer className="w-full" config={referrals.config}>
                <BarChart accessibilityLayer data={referrals.series} margin={{ left: -16 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    axisLine={false}
                    dataKey="day"
                    minTickGap={32}
                    tickFormatter={formatDay}
                    tickLine={false}
                    tickMargin={8}
                  />
                  <YAxis allowDecimals={false} axisLine={false} tickLine={false} width={48} />
                  <ChartTooltip
                    content={
                      <SourcesTooltipContent config={referrals.config} />
                    }
                  />
                  {Object.keys(referrals.config).map((id) => (
                    <Bar
                      key={id}
                      dataKey={id}
                      fill={`var(--color-${id})`}
                      maxBarSize={24}
                      stackId="sources"
                    />
                  ))}
                </BarChart>
              </ChartContainer>
              {/* The legend renders as its own row below the plot, in the
                  survey's order, so it wraps freely at narrow widths. */}
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
                {Object.entries(referrals.config).map(([id, entry]) => (
                  <span key={id} className="flex items-center gap-1.5 whitespace-nowrap">
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: "color" in entry ? entry.color : undefined }}
                    />
                    {entry.label}
                  </span>
                ))}
              </div>
            </ChartCard>
          ),
        }
      : {}),
    ...(revenue && billing && links
      ? {
          revenue: (
            <ChartCard
              title="Revenue"
              subtitle={
                <span className="flex flex-wrap gap-x-3 gap-y-1">
                  <StripeLink href={links.paid}>
                    {formatMicros(billing.window.netMicros)} net
                  </StripeLink>
                  <StripeLink href={links.refunded}>
                    {formatMicros(billing.window.refundedMicros)} refunded
                  </StripeLink>
                  <StripeLink href={links.declined}>
                    {formatMicros(billing.window.declinedMicros)} declined
                  </StripeLink>
                  <StripeLink href={links.canceled}>
                    {billing.window.cancels} canceled
                  </StripeLink>
                  <span>· last 60 days</span>
                </span>
              }
            >
              <ChartContainer className="max-h-56 w-full" config={revenueConfig}>
                {/* The money and the declined bars are two stacks, which the
                    chart would set side by side in each day's band; a gap
                    equal to a slot lays them over each other, so the bar
                    sits on the band's center with the hover band and the
                    cancel dot. */}
                <BarChart
                  accessibilityLayer
                  barGap="-80%"
                  data={revenue}
                  margin={{ left: -16 }}
                >
                  <CartesianGrid vertical={false} />
                  <XAxis
                    axisLine={false}
                    dataKey="day"
                    minTickGap={32}
                    tickFormatter={formatDay}
                    tickLine={false}
                    tickMargin={8}
                  />
                  <YAxis
                    axisLine={false}
                    tickFormatter={(value) => formatDollars(Number(value))}
                    tickLine={false}
                    width={48}
                  />
                  <ChartTooltip content={<RevenueTooltipContent events={billing.events} />} />
                  {revenue
                    .filter((point) => point.cancels > 0)
                    .map((point) => (
                      <ReferenceLine
                        key={point.day}
                        x={point.day}
                        stroke="none"
                        label={<CancelMarker />}
                      />
                    ))}
                  <Bar dataKey="pro" fill="var(--color-pro)" maxBarSize={24} stackId="money" />
                  <Bar dataKey="topups" fill="var(--color-topups)" maxBarSize={24} stackId="money" />
                  {revenue.some((point) => point.other > 0) && (
                    <Bar dataKey="other" fill="var(--color-other)" maxBarSize={24} stackId="money" />
                  )}
                  <Bar dataKey="refunds" fill="var(--color-refunds)" maxBarSize={24} stackId="money" />
                  <Bar dataKey="declined" fill="var(--color-declined)" maxBarSize={24} stackId="declined" />
                  <ChartLegend content={<ChartLegendContent />} />
                </BarChart>
              </ChartContainer>
              {billing.events.length > 0 && (
                <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                  {billing.events.slice(0, BILLING_EVENTS_SHOWN).map((event) => {
                    const href =
                      event.kind === "canceled"
                        ? event.objectId
                          ? links.subscription(event.objectId)
                          : links.canceled
                        : event.objectId
                          ? links.payment(event.objectId)
                          : links.declined;
                    return (
                      <li
                        key={`${event.kind}-${event.objectId ?? event.day}`}
                        className="flex flex-wrap items-baseline gap-x-2"
                      >
                        <span className="w-12 shrink-0 tabular-nums">{formatDay(event.day)}</span>
                        <StripeLink href={href} className="text-foreground">
                          {event.kind === "canceled"
                            ? "canceled"
                            : `${formatMicros(event.amountMicros ?? "0")} declined`}
                        </StripeLink>
                        {event.kind === "canceled" && (
                          <span className="shrink-0 text-foreground">{cancelStatus(event)}</span>
                        )}
                        <span className="truncate">{event.email ?? "unknown customer"}</span>
                        {event.detail && (
                          <span className="min-w-0 flex-1 truncate" title={event.detail}>
                            {event.detail}
                          </span>
                        )}
                      </li>
                    );
                  })}
                  {billing.events.length > BILLING_EVENTS_SHOWN && (
                    <li>
                      <StripeLink href={links.declined}>
                        +{billing.events.length - BILLING_EVENTS_SHOWN} more in Stripe
                      </StripeLink>
                    </li>
                  )}
                </ul>
              )}
            </ChartCard>
          ),
        }
      : {}),
  };

  return (
    <div className="space-y-6 pb-9">
      {(tiles.customized || cards.customized) && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => {
              tiles.reset();
              cards.reset();
            }}
            className="text-xs text-muted-foreground underline-offset-4 hover:underline"
          >
            Reset layout
          </button>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" {...tiles.containerProps}>
        {tiles.order.map((id) => (
          <DragBlock key={id} {...tiles.blockProps(id)}>
            {tileNodes[id]}
          </DragBlock>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-2" {...cards.containerProps}>
        {cards.order
          .filter((id) => cardNodes[id] !== undefined)
          .map((id) => (
            <DragBlock key={id} {...cards.blockProps(id)} className={cardSpan[id]}>
              {cardNodes[id]}
            </DragBlock>
          ))}
      </div>

      <ActivityGrid missingDays={view.missingDays} rollup={data} workBits={view.workBits} />

      <p className="text-xs text-muted-foreground">
        From the nightly rollup generated{" "}
        {new Date(data.generatedAt).toLocaleString("en-US", { timeZoneName: "short" })}.
      </p>
    </div>
  );
}
