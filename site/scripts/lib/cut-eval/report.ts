/**
 * The latency eval's report: schema cut-chat-latency/v1. One report holds one
 * or more model configs; each config holds per-case runs with full timings and
 * per-bucket aggregates. Latency aggregates count passing runs only — a wrong
 * answer's speed means nothing — with pass rate reported alongside so a
 * fast-but-wrong config stays visible.
 */

import type { Bucket, EvalCase } from "./cases";
import type { CaseResult, RunTimings, TraceEntry } from "./harness";

export interface Agg {
  p50: number;
  p95: number;
  mean: number;
  n: number;
}

export interface RunReport {
  pass: boolean;
  intent: string;
  notes: string[];
  trace: TraceEntry[];
  timings: RunTimings | null;
  /** Set when the run threw (dev server down, non-retryable upstream error). */
  error?: string;
}

export interface CaseLatency {
  gateMs: Agg;
  ttftMs: Agg | null;
  totalMs: Agg;
  modelMs: Agg;
  toolMs: Agg;
  rounds: { mean: number; max: number };
}

export interface CaseReport {
  name: string;
  bucket: Bucket;
  passRate: number;
  budgetBreaches: string[];
  /** Passing runs only; null when no run passed. */
  latency: CaseLatency | null;
  runs: RunReport[];
}

export interface BucketSummary {
  cases: number;
  passRate: number;
  gateMs: Agg | null;
  ttftMs: Agg | null;
  totalMs: Agg | null;
  meanRounds: number | null;
}

export interface ConfigReport {
  label: string;
  chatModel: string;
  gateModel: string;
  buckets: Partial<Record<Bucket, BucketSummary>>;
  cases: CaseReport[];
}

export interface LatencyReport {
  schema: "cut-chat-latency/v1";
  generatedAt: string;
  base: string;
  runsPerCase: number;
  configs: ConfigReport[];
}

const r0 = (x: number) => Math.round(x);

const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
};

export function agg(values: number[]): Agg | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: r0(percentile(sorted, 50)),
    p95: r0(percentile(sorted, 95)),
    mean: r0(values.reduce((s, v) => s + v, 0) / values.length),
    n: values.length,
  };
}

export function toRunReport(result: CaseResult | null, error?: string): RunReport {
  if (!result) return { pass: false, intent: "work", notes: [], trace: [], timings: null, error };
  return {
    pass: result.pass,
    intent: result.intent,
    notes: result.notes,
    trace: result.trace,
    timings: result.timings,
  };
}

export function buildCaseReport(c: EvalCase, runs: RunReport[]): CaseReport {
  const passing = runs.filter((r) => r.pass && r.timings).map((r) => r.timings as RunTimings);
  const passRate = runs.length > 0 ? passing.length / runs.length : 0;
  let latency: CaseLatency | null = null;
  if (passing.length > 0) {
    const ttfts = passing.map((t) => t.ttftMs).filter((v): v is number => v !== null);
    latency = {
      gateMs: agg(passing.map((t) => t.gateMs)) as Agg,
      ttftMs: agg(ttfts),
      totalMs: agg(passing.map((t) => t.totalMs)) as Agg,
      modelMs: agg(passing.map((t) => t.modelMs)) as Agg,
      toolMs: agg(passing.map((t) => t.toolMs)) as Agg,
      rounds: {
        mean: Math.round((passing.reduce((s, t) => s + t.rounds.length, 0) / passing.length) * 10) / 10,
        max: Math.max(...passing.map((t) => t.rounds.length)),
      },
    };
  }
  const budgetBreaches: string[] = [];
  if (c.budget && latency) {
    const checks: [string, number | undefined, Agg | null][] = [
      ["totalMs", c.budget.totalMs, latency.totalMs],
      ["ttftMs", c.budget.ttftMs, latency.ttftMs],
      ["gateMs", c.budget.gateMs, latency.gateMs],
    ];
    for (const [key, budget, a] of checks) {
      if (budget !== undefined && a && a.p50 > budget)
        budgetBreaches.push(`${key} p50 ${a.p50} > budget ${budget}`);
    }
  }
  return { name: c.name, bucket: c.bucket, passRate, budgetBreaches, latency, runs };
}

export function buildBucketSummaries(
  caseReports: CaseReport[]
): Partial<Record<Bucket, BucketSummary>> {
  const buckets: Partial<Record<Bucket, BucketSummary>> = {};
  for (const bucket of new Set(caseReports.map((c) => c.bucket))) {
    const cs = caseReports.filter((c) => c.bucket === bucket);
    const withLatency = cs.filter((c) => c.latency !== null);
    const flat = <K extends "gateMs" | "totalMs" | "modelMs">(key: K) =>
      agg(withLatency.map((c) => (c.latency as CaseLatency)[key].p50));
    buckets[bucket] = {
      cases: cs.length,
      passRate:
        Math.round((cs.reduce((s, c) => s + c.passRate, 0) / cs.length) * 100) / 100,
      gateMs: flat("gateMs"),
      ttftMs: agg(
        withLatency
          .map((c) => c.latency?.ttftMs?.p50)
          .filter((v): v is number => typeof v === "number")
      ),
      totalMs: flat("totalMs"),
      meanRounds:
        withLatency.length > 0
          ? Math.round(
              (withLatency.reduce((s, c) => s + (c.latency as CaseLatency).rounds.mean, 0) /
                withLatency.length) *
                10
            ) / 10
          : null,
    };
  }
  return buckets;
}
