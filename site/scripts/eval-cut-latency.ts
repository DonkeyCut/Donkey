#!/usr/bin/env bun
/**
 * Latency evals for the Cut assistant chat: how fast the model reaches the
 * right tools, and how fast plain conversation turns complete.
 *
 * Runs the shared cases (scripts/lib/cut-eval/) with full timing — gate,
 * time-to-first-token, per-round wall, tool serve — and writes a
 * machine-readable report (schema cut-chat-latency/v1) beside a human table.
 * Latency aggregates count passing runs only; pass rate rides alongside.
 *
 * Run with the site dev server up:
 *   bun run scripts/eval-cut-latency.ts
 *     [--base http://localhost:3000]
 *     [--only <case>] [--bucket chat|single-tool|multi-tool]
 *     [--runs N]                      default 3
 *     [--model <registryKey|rawId>]   chat model (flash, flashLite, or a raw id)
 *     [--gate-model <registryKey|rawId>]
 *     [--matrix]                      run every CANDIDATES row, compare
 *     [--enforce-budgets]             exit 1 when a case breaches its budget
 *     [--out <path>]                  default <repo>/evals/cut-chat-latency.latest-report.json
 *
 * See scripts/lib/cut-eval/README.md for the improvement loop.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { geminiModelRoles, geminiModels } from "../src/lib/inference/gemini-models";
import { cases, type Bucket, type EvalCase } from "./lib/cut-eval/cases";
import { makeFixtureAudio } from "./lib/cut-eval/fixtures";
import { runCase, type RunConfig } from "./lib/cut-eval/harness";
import {
  buildBucketSummaries,
  buildCaseReport,
  toRunReport,
  type CaseReport,
  type ConfigReport,
  type LatencyReport,
  type RunReport,
} from "./lib/cut-eval/report";

// Model configs the --matrix mode compares. Add a row when trialing a new
// model id; keep "baseline" matching geminiModelRoles so the comparison always
// includes what production runs.
const CANDIDATES: { label: string; chat: string; gate: string }[] = [
  { label: "baseline", chat: geminiModelRoles.chat, gate: geminiModelRoles.fastDecision },
  { label: "chat=flashLite", chat: geminiModels.flashLite, gate: geminiModelRoles.fastDecision },
  { label: "gate=flash", chat: geminiModelRoles.chat, gate: geminiModels.flash },
];

const args = process.argv.slice(2);
const argValue = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const BASE = argValue("--base") ?? "http://localhost:3000";
const ONLY = argValue("--only");
const BUCKET = argValue("--bucket") as Bucket | undefined;
const RUNS = Number(argValue("--runs") ?? 3);
const MATRIX = args.includes("--matrix");
const ENFORCE_BUDGETS = args.includes("--enforce-budgets");
const OUT = resolve(
  argValue("--out") ??
    join(dirname(fileURLToPath(import.meta.url)), "../../evals/cut-chat-latency.latest-report.json")
);

/** A registry key (flash, flashLite, …) or a raw model id. */
const resolveModel = (v: string): string =>
  (geminiModels as Record<string, string>)[v] ?? v;

const ms = (v: number | null | undefined) => (typeof v === "number" ? `${v}ms` : "—");
const pct = (v: number) => `${Math.round(v * 100)}%`;

function printTable(header: string[], rows: string[][]) {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  for (const [n, row] of all.entries()) {
    console.log(row.map((cell, i) => cell.padEnd(widths[i])).join("  "));
    if (n === 0) console.log(widths.map((w) => "-".repeat(w)).join("  "));
  }
}

async function runConfig(
  label: string,
  cfg: RunConfig,
  selected: EvalCase[]
): Promise<ConfigReport> {
  console.log(`\n== ${label}  chat=${cfg.chatModel}  gate=${cfg.gateModel}`);
  const caseReports: CaseReport[] = [];
  for (const c of selected) {
    const runs: RunReport[] = [];
    for (let run = 1; run <= RUNS; run++) {
      try {
        runs.push(toRunReport(await runCase(c, cfg)));
      } catch (err) {
        runs.push(toRunReport(null, err instanceof Error ? err.message : String(err)));
      }
    }
    const report = buildCaseReport(c, runs);
    caseReports.push(report);
    const l = report.latency;
    console.log(
      `  ${report.passRate === 1 ? "ok  " : report.passRate > 0 ? "part" : "FAIL"} ${c.name}` +
        `  pass ${pct(report.passRate)}  total p50 ${ms(l?.totalMs.p50)}  ttft p50 ${ms(l?.ttftMs?.p50)}` +
        `  rounds ${l ? l.rounds.mean : "—"}` +
        (report.budgetBreaches.length > 0 ? `  BUDGET: ${report.budgetBreaches.join("; ")}` : "")
    );
    for (const r of runs.filter((r) => !r.pass)) {
      for (const n of r.error ? [r.error] : r.notes) console.log(`       - ${n}`);
    }
  }
  return {
    label,
    chatModel: cfg.chatModel,
    gateModel: cfg.gateModel,
    buckets: buildBucketSummaries(caseReports),
    cases: caseReports,
  };
}

async function main() {
  const audio = makeFixtureAudio();
  const selected = cases(audio).filter(
    (c) => (!ONLY || c.name === ONLY) && (!BUCKET || c.bucket === BUCKET)
  );
  if (selected.length === 0)
    throw new Error(ONLY ? `No case named "${ONLY}".` : `No cases in bucket "${BUCKET}".`);

  const configs = MATRIX
    ? CANDIDATES.map((cand) => ({
        label: cand.label,
        cfg: { base: BASE, chatModel: cand.chat, gateModel: cand.gate },
      }))
    : [
        {
          label: "config",
          cfg: {
            base: BASE,
            chatModel: resolveModel(argValue("--model") ?? geminiModelRoles.chat),
            gateModel: resolveModel(argValue("--gate-model") ?? geminiModelRoles.fastDecision),
          },
        },
      ];

  const report: LatencyReport = {
    schema: "cut-chat-latency/v1",
    generatedAt: new Date().toISOString(),
    base: BASE,
    runsPerCase: RUNS,
    configs: [],
  };
  for (const { label, cfg } of configs) {
    report.configs.push(await runConfig(label, cfg, selected));
  }

  console.log("");
  printTable(
    ["config", "bucket", "cases", "pass", "gate p50", "ttft p50", "total p50", "rounds"],
    report.configs.flatMap((c) =>
      (Object.entries(c.buckets) as [Bucket, NonNullable<ConfigReport["buckets"][Bucket]>][]).map(
        ([bucket, s]) => [
          c.label,
          bucket,
          String(s.cases),
          pct(s.passRate),
          ms(s.gateMs?.p50),
          ms(s.ttftMs?.p50),
          ms(s.totalMs?.p50),
          s.meanRounds === null ? "—" : String(s.meanRounds),
        ]
      )
    )
  );

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nReport: ${OUT}`);

  const dead = report.configs.flatMap((c) =>
    c.cases.filter((x) => x.passRate === 0).map((x) => `${c.label}/${x.name}`)
  );
  const breaches = report.configs.flatMap((c) =>
    c.cases.filter((x) => x.budgetBreaches.length > 0).map((x) => `${c.label}/${x.name}`)
  );
  if (dead.length > 0) {
    console.log(`\nNo passing runs: ${dead.join(", ")}`);
    process.exit(1);
  }
  if (ENFORCE_BUDGETS && breaches.length > 0) {
    console.log(`\nBudget breaches: ${breaches.join(", ")}`);
    process.exit(1);
  }
}

void main();
