"use client";

import { useMemo } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import type { AnalyticsBilling, AnalyticsReferrals, AnalyticsRollup } from "@/lib/analytics/schema";
import { REFERRAL_SOURCES } from "@/lib/onboarding/sequence";
import { useLocalPref } from "@/cut/lib/uiState";
import { cn } from "@/lib/utils";
import { useAnalyticsRollup } from "@/queries/analytics";
import { ApiError } from "@/queries/apiClient";

// Everything here renders the nightly rollup (analytics/rollup.json via
// /api/analytics/rollup) — stale until the next job run by design. "Active" is
// any source bit for the day; "working" narrows to the DB event sources, i.e.
// the user did something beyond opening the app.

function formatDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatMicros(micros: bigint): string {
  return `$${(Number(micros) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
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
  series: Record<string, number | string>[];
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
  const series: Record<string, number | string>[] = [];
  const cumulative: Record<string, number | string>[] = [];
  for (const entry of referrals.days) {
    respondents += entry.respondents;
    const daily: Record<string, number | string> = { day: entry.day };
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

/** The shared tooltip minus the noise: a day's zero rows say nothing on a
 * chart whose series are sparse, so only sources with a count show. */
function NonZeroTooltipContent(props: React.ComponentProps<typeof ChartTooltipContent>) {
  return (
    <ChartTooltipContent {...props} payload={props.payload?.filter((item) => item.value !== 0)} />
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

const revenueConfig = {
  pro: { label: "Pro", color: "var(--chart-1)" },
  topups: { label: "Top-ups", color: "var(--chart-2)" },
} satisfies ChartConfig;

// Per-day dollars from the rollup's micro strings, aligned with its days.
function deriveRevenue(days: string[], billing: AnalyticsBilling) {
  return days.map((day, i) => ({
    day,
    pro: Number(BigInt(billing.revenue[i]?.proMicros ?? "0")) / 1e6,
    topups: Number(BigInt(billing.revenue[i]?.topupMicros ?? "0")) / 1e6,
  }));
}

function StatTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-card p-5">
      <p className="text-sm text-muted-foreground">{label}</p>
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
  subtitle: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-xl border bg-card p-5", className)}>
      <p className="font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{subtitle}</p>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function ActivityDot({
  mask,
  workBits,
  label,
  unknown,
}: {
  mask: number;
  workBits: number;
  label: string;
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
      title={label}
    />
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
  const dotLabel = (email: string, day: string, mask: number) => {
    if (missingDays.has(day)) return `${email} — ${formatDay(day)}: no data`;
    if (mask === 0) return `${email} — ${formatDay(day)}: inactive`;
    const sources = rollup.sources.filter((_, i) => (mask & (1 << i)) !== 0);
    return `${email} — ${formatDay(day)}: ${sources.join(", ")}`;
  };
  // Newest day sits in the leftmost column so the current dots are in view
  // before any horizontal scroll; each column keeps its index into the
  // activity masks.
  const columns = rollup.days.map((day, i) => ({ day, i })).reverse();
  // Paying users first; the stable sort keeps recency within each group.
  const users = [...rollup.users].sort(
    (a, b) => Number(b.fundedMicros !== undefined) - Number(a.fundedMicros !== undefined),
  );
  return (
    <div className="rounded-xl border bg-card p-5">
      <p className="font-medium">User activity</p>
      <p className="text-sm text-muted-foreground">
        One dot per user per day, last {rollup.days.length} days
        {missingDays.size > 0 && ` · ${missingDays.size} without data`}
      </p>
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
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td className="sticky left-0 z-10 bg-card py-1 pr-4 whitespace-nowrap">
                  <span className="block max-w-56 truncate text-sm" title={user.name}>
                    {user.email}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Joined {formatDay(user.registeredAt.slice(0, 10))} ·{" "}
                    {formatMicros(BigInt(user.balanceMicros))}
                    {user.fundedMicros !== undefined && (
                      <span className="text-emerald-700 dark:text-emerald-500">
                        {" "}
                        · paid {formatMicros(BigInt(user.fundedMicros))}
                      </span>
                    )}
                  </span>
                </td>
                {columns.map(({ day, i }) => (
                  <td key={day} className="p-0.5">
                    <ActivityDot
                      label={dotLabel(user.email, day, user.activity[i] ?? 0)}
                      mask={user.activity[i] ?? 0}
                      unknown={missingDays.has(day)}
                      workBits={workBits}
                    />
                  </td>
                ))}
              </tr>
            ))}
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
  const revenue = useMemo(
    () => (rollup.data?.billing ? deriveRevenue(rollup.data.days, rollup.data.billing) : null),
    [rollup.data],
  );
  // Trend lines toggled off stay off across visits.
  const [hiddenTrends, setHiddenTrends] = useLocalPref<string[]>(
    "su-referral-hidden-trends",
    [],
    (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
  );

  if (rollup.isPending) {
    return (
      <div className="space-y-6 pb-9">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 7 }, (_, i) => (
            <Skeleton key={i} className="h-[104px] rounded-xl" />
          ))}
        </div>
        <div className="grid gap-6 xl:grid-cols-2">
          <Skeleton className="h-96 rounded-xl" />
          <Skeleton className="h-96 rounded-xl" />
          <Skeleton className="h-96 rounded-xl" />
          <Skeleton className="h-96 rounded-xl" />
        </div>
        <Skeleton className="h-80 rounded-xl" />
      </div>
    );
  }

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
  // Billing is absent from rollups written before it shipped; the next run
  // fills it in.
  const billing = data.billing;
  const churnBase = billing ? billing.subscribers + billing.churned : 0;
  const staleBilling = "not in this rollup yet — run analytics";

  return (
    <div className="space-y-6 pb-9">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Registered users"
          value={view.registered.toLocaleString("en-US")}
          sub={`+${view.signups7d} in the last 7 days`}
        />
        <StatTile
          label="Active yesterday"
          value={count(view.activeYesterday)}
          sub={
            view.activeYesterday === null
              ? `no extract for ${formatDay(lastDay)} yet`
              : `of ${view.registered.toLocaleString("en-US")} registered`
          }
        />
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
        <StatTile
          label="Outstanding balance"
          value={formatMicros(view.totalBalanceMicros)}
          sub="credits across all accounts"
        />
        <StatTile
          label="Pro subscribers"
          value={billing ? billing.subscribers.toLocaleString("en-US") : "—"}
          sub={billing ? `${billing.canceling} canceling at period end` : staleBilling}
        />
        <StatTile
          label="People funded"
          value={billing ? billing.funded.toLocaleString("en-US") : "—"}
          sub={
            billing ? `${formatMicros(BigInt(billing.fundedMicros))} paid all time` : staleBilling
          }
        />
        <StatTile
          label="Churn rate"
          value={
            billing && churnBase > 0
              ? `${((billing.churned / churnBase) * 100).toFixed(1)}%`
              : "—"
          }
          sub={
            !billing
              ? staleBilling
              : churnBase === 0
                ? "no subscriptions yet"
                : `${billing.churned} of ${churnBase} subscriptions ended`
          }
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
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
                content={<ChartTooltipContent labelFormatter={(label) => formatDay(String(label))} />}
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
              <ChartTooltip
                content={<ChartTooltipContent labelFormatter={(label) => formatDay(String(label))} />}
              />
              <Bar
                dataKey="signups"
                fill="var(--color-signups)"
                maxBarSize={24}
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ChartContainer>
        </ChartCard>
      </div>

      {referrals && (
        <div className="grid gap-6 xl:grid-cols-2">
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
                    <NonZeroTooltipContent labelFormatter={(label) => formatDay(String(label))} />
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
                    <NonZeroTooltipContent labelFormatter={(label) => formatDay(String(label))} />
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
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        {revenue && (
          <ChartCard
            title="Revenue"
            subtitle={`Paid Stripe charges per day · $${revenue
              .reduce((sum, point) => sum + point.pro + point.topups, 0)
              .toLocaleString("en-US", { maximumFractionDigits: 2 })} in the last 60 days`}
          >
            <ChartContainer className="max-h-56 w-full" config={revenueConfig}>
              <BarChart accessibilityLayer data={revenue} margin={{ left: -16 }}>
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
                  tickFormatter={(value) => `$${value}`}
                  tickLine={false}
                  width={48}
                />
                <ChartTooltip
                  content={
                    <NonZeroTooltipContent labelFormatter={(label) => formatDay(String(label))} />
                  }
                />
                <Bar dataKey="pro" fill="var(--color-pro)" maxBarSize={24} stackId="revenue" />
                <Bar
                  dataKey="topups"
                  fill="var(--color-topups)"
                  maxBarSize={24}
                  stackId="revenue"
                />
                <ChartLegend content={<ChartLegendContent />} />
              </BarChart>
            </ChartContainer>
          </ChartCard>
        )}
        <ChartCard
          title="Total registered"
          subtitle="Cumulative registrations, last 60 days"
          className={cn(!revenue && "xl:col-span-2")}
        >
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
              <ChartTooltip
                content={
                  <ChartTooltipContent labelFormatter={(label) => formatDay(String(label))} />
                }
              />
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
      </div>

      <ActivityGrid missingDays={view.missingDays} rollup={data} workBits={view.workBits} />

      <p className="text-xs text-muted-foreground">
        From the nightly rollup generated{" "}
        {new Date(data.generatedAt).toLocaleString("en-US", { timeZoneName: "short" })}.
      </p>
    </div>
  );
}
