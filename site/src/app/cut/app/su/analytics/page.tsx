"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
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
import { cn } from "@/lib/utils";

// Everything on this page is placeholder data proving out the chart setup. The
// shapes mirror what the real su analytics endpoints will return — a row per
// UTC day with one numeric field per series — so wiring in TanStack Query
// hooks later is a data swap, not a rebuild.

const DAY_MS = 86_400_000;
// Fixed end date so the series is identical on server and client — Date.now()
// here would flip day labels across the hydration boundary.
const SERIES_END_UTC = Date.UTC(2026, 7, 1);

function buildDays(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    new Date(SERIES_END_UTC - (count - 1 - i) * DAY_MS).toISOString().slice(0, 10),
  );
}

function formatDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// Deterministic wave + weekend dip + drift, so the demo reads like real
// traffic instead of noise.
const CALLS_30D = buildDays(30).map((day, i) => ({
  day,
  app: 320 + Math.round(140 * Math.sin(i / 4.2)) + (i % 7 < 2 ? -90 : 0) + i * 6,
  vision: 140 + Math.round(60 * Math.sin(i / 3.1 + 2)) + (i % 7 < 2 ? -30 : 0) + i * 2,
}));

const SPEND_14D = buildDays(14).map((day, i) => {
  const gemini = 14 + Math.round(5 * Math.sin(i / 2.4)) + (i % 7 < 2 ? -4 : 0);
  const elevenlabs = 6 + Math.round(2 * Math.sin(i / 3 + 1));
  const openai = 2 + ((i * 5) % 4);
  return { day, gemini, elevenlabs, openai, total: gemini + elevenlabs + openai };
});

const callsConfig = {
  app: { label: "App", color: "var(--chart-1)" },
  vision: { label: "Vision API", color: "var(--chart-2)" },
} satisfies ChartConfig;

const spendConfig = {
  gemini: { label: "Gemini", color: "var(--chart-1)" },
  elevenlabs: { label: "ElevenLabs", color: "var(--chart-2)" },
  openai: { label: "OpenAI", color: "var(--chart-3)" },
} satisfies ChartConfig;

const STAT_TILES = [
  { label: "Active users", value: "1,284", delta: "+12.4%" },
  { label: "Renders", value: "3,908", delta: "+8.2%" },
  { label: "Inference calls", value: "12.9K", delta: "-3.1%" },
  { label: "Credits spent", value: "$412", delta: "+21.0%" },
];

function StatTile({
  label,
  value,
  delta,
}: {
  label: string;
  value: string;
  delta: string;
}) {
  const negative = delta.startsWith("-");
  return (
    <div className="rounded-xl border bg-card p-5">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      <p className="mt-1 text-xs">
        <span
          className={cn(
            negative ? "text-destructive" : "text-emerald-700 dark:text-emerald-500",
          )}
        >
          {delta}
        </span>{" "}
        <span className="text-muted-foreground">vs prior 30 days</span>
      </p>
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

export default function SuAnalyticsPage() {
  return (
    <div className="space-y-6 pb-9">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {STAT_TILES.map((tile) => (
          <StatTile key={tile.label} {...tile} />
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <ChartCard title="Inference calls" subtitle="Daily calls by product, last 30 days">
          <ChartContainer className="w-full" config={callsConfig}>
            <AreaChart accessibilityLayer data={CALLS_30D} margin={{ left: -16 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                axisLine={false}
                dataKey="day"
                minTickGap={32}
                tickFormatter={formatDay}
                tickLine={false}
                tickMargin={8}
              />
              <YAxis axisLine={false} tickLine={false} width={48} />
              <ChartTooltip
                content={<ChartTooltipContent labelFormatter={(label) => formatDay(String(label))} />}
              />
              <Area
                dataKey="app"
                dot={false}
                fill="var(--color-app)"
                fillOpacity={0.1}
                stroke="var(--color-app)"
                strokeWidth={2}
                type="monotone"
              />
              <Area
                dataKey="vision"
                dot={false}
                fill="var(--color-vision)"
                fillOpacity={0.1}
                stroke="var(--color-vision)"
                strokeWidth={2}
                type="monotone"
              />
              <ChartLegend content={<ChartLegendContent />} />
            </AreaChart>
          </ChartContainer>
        </ChartCard>

        <ChartCard title="Credits spent" subtitle="Daily spend by provider, last 14 days">
          <ChartContainer className="w-full" config={spendConfig}>
            <BarChart accessibilityLayer data={SPEND_14D} margin={{ left: -16 }}>
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
                tickFormatter={(value: number) => `$${value}`}
                tickLine={false}
                width={48}
              />
              <ChartTooltip
                content={<ChartTooltipContent labelFormatter={(label) => formatDay(String(label))} />}
              />
              {/* Surface-color strokes are the 2px gap separating stacked
                  segments; only the top segment rounds, the baseline stays
                  square. */}
              <Bar
                dataKey="gemini"
                fill="var(--color-gemini)"
                maxBarSize={24}
                stackId="spend"
                stroke="var(--card)"
                strokeWidth={2}
              />
              <Bar
                dataKey="elevenlabs"
                fill="var(--color-elevenlabs)"
                maxBarSize={24}
                stackId="spend"
                stroke="var(--card)"
                strokeWidth={2}
              />
              <Bar
                dataKey="openai"
                fill="var(--color-openai)"
                maxBarSize={24}
                radius={[4, 4, 0, 0]}
                stackId="spend"
                stroke="var(--card)"
                strokeWidth={2}
              >
                <LabelList
                  className="fill-muted-foreground"
                  dataKey="total"
                  fontSize={10}
                  formatter={(value) => `$${String(value)}`}
                  position="top"
                />
              </Bar>
              <ChartLegend content={<ChartLegendContent />} />
            </BarChart>
          </ChartContainer>
        </ChartCard>
      </div>
    </div>
  );
}
