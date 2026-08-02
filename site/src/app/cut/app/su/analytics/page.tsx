"use client";

import { useMemo } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { AnalyticsRollup } from "@/lib/analytics/schema";
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

type DayPoint = {
  day: string;
  active: number;
  working: number;
  signups: number;
  totalRegistered: number;
};

type RollupView = {
  series: DayPoint[];
  workBits: number;
  registered: number;
  signups7d: number;
  signupsWindow: number;
  activeYesterday: number;
  active7d: number;
  activePrior7d: number;
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

  const series = rollup.days.map((day, i) => {
    let active = 0;
    let working = 0;
    for (const user of rollup.users) {
      const mask = user.activity[i] ?? 0;
      if (mask !== 0) active++;
      if ((mask & workBits) !== 0) working++;
    }
    const signups = signupsByDay.get(day) ?? 0;
    totalRegistered += signups;
    return { active, day, signups, totalRegistered, working };
  });

  const activeInRange = (from: number, to: number) => {
    let count = 0;
    for (const user of rollup.users) {
      for (let i = Math.max(0, from); i < to; i++) {
        if ((user.activity[i] ?? 0) !== 0) {
          count++;
          break;
        }
      }
    }
    return count;
  };

  const len = rollup.days.length;
  const last7 = rollup.days.slice(-7);
  return {
    active7d: activeInRange(len - 7, len),
    activePrior7d: activeInRange(len - 14, len - 7),
    activeYesterday: series[len - 1]?.active ?? 0,
    registered: rollup.users.length,
    series,
    signups7d: last7.reduce((sum, day) => sum + (signupsByDay.get(day) ?? 0), 0),
    signupsWindow: series.reduce((sum, point) => sum + point.signups, 0),
    totalBalanceMicros: rollup.users.reduce((sum, u) => sum + BigInt(u.balanceMicros), BigInt(0)),
    workBits,
  };
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
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-card p-5">
      <p className="font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{subtitle}</p>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function ActivityDot({ mask, workBits, label }: { mask: number; workBits: number; label: string }) {
  const worked = (mask & workBits) !== 0;
  const visited = mask !== 0;
  return (
    <span
      className={cn(
        "block size-2 rounded-full",
        worked
          ? "bg-[var(--chart-1)]"
          : visited
            ? "bg-[var(--chart-1)] opacity-40"
            : "bg-muted",
      )}
      title={label}
    />
  );
}

function ActivityGrid({ rollup, workBits }: { rollup: AnalyticsRollup; workBits: number }) {
  const dotLabel = (email: string, day: string, mask: number) => {
    if (mask === 0) return `${email} — ${formatDay(day)}: inactive`;
    const sources = rollup.sources.filter((_, i) => (mask & (1 << i)) !== 0);
    return `${email} — ${formatDay(day)}: ${sources.join(", ")}`;
  };
  return (
    <div className="rounded-xl border bg-card p-5">
      <p className="font-medium">User activity</p>
      <p className="text-sm text-muted-foreground">
        One dot per user per day, last {rollup.days.length} days
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="border-separate border-spacing-0">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-card" />
              {rollup.days.map((day, i) => (
                <th
                  key={day}
                  className="pb-2 text-left text-[10px] font-normal whitespace-nowrap text-muted-foreground"
                >
                  {i === 0 || day.endsWith("-01") ? formatDay(day) : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rollup.users.map((user) => (
              <tr key={user.id}>
                <td className="sticky left-0 z-10 bg-card py-1 pr-4 whitespace-nowrap">
                  <span className="block max-w-56 truncate text-sm" title={user.name}>
                    {user.email}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Joined {formatDay(user.registeredAt.slice(0, 10))} ·{" "}
                    {formatMicros(BigInt(user.balanceMicros))}
                  </span>
                </td>
                {rollup.days.map((day, i) => (
                  <td key={day} className="p-0.5">
                    <ActivityDot
                      label={dotLabel(user.email, day, user.activity[i] ?? 0)}
                      mask={user.activity[i] ?? 0}
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

  if (rollup.isPending) return null;

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
    view.activePrior7d > 0
      ? `${(((view.active7d - view.activePrior7d) / view.activePrior7d) * 100).toFixed(1)}%`
      : null;

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
          value={view.activeYesterday.toLocaleString("en-US")}
          sub={`of ${view.registered.toLocaleString("en-US")} registered`}
        />
        <StatTile
          label="Active last 7 days"
          value={view.active7d.toLocaleString("en-US")}
          sub={
            deltaPct === null ? (
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
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <ChartCard title="Active users" subtitle="Daily actives, last 60 days">
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
            <ChartTooltip
              content={<ChartTooltipContent labelFormatter={(label) => formatDay(String(label))} />}
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

      <ActivityGrid rollup={data} workBits={view.workBits} />

      <p className="text-xs text-muted-foreground">
        From the nightly rollup generated{" "}
        {new Date(data.generatedAt).toLocaleString("en-US", { timeZoneName: "short" })}.
      </p>
    </div>
  );
}
