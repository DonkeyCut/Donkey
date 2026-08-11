#!/usr/bin/env bun
/**
 * The Cut chat eval: behavior and speed in one run.
 *
 * Each case replays a real composer turn (system prompt, tool catalog,
 * <attached_assets>, <editor_state>, inline audio) against the live chat
 * model through the hosted Responses route and asserts on what the model
 * does — questions answer in chat without project-mutating tool calls, edit
 * requests reach the right tools — while timing the whole path: the gate,
 * time-to-first-token, every round, every tool serve.
 *
 * Run with the site dev server up:
 *   bun run scripts/eval-cut-chat.ts
 *     [--base http://localhost:3000]
 *     [--only <case>[,<case>…]] [--bucket chat|single-tool|multi-tool]
 *     [--runs N]                      default 1; use 3+ for latency stats
 *     [--model <registryKey|rawId>]   pin BOTH chat roles to one model (unrouted)
 *     [--simple-model <id>] [--complex-model <id>]  override one routed role
 *     [--gate-model <registryKey|rawId>]
 *     [--matrix]                      run every CANDIDATES row, compare
 *     [--no-judge]                    skip the voice/taste judge call
 *     [--enforce-budgets]             exit 1 when a case breaches its budget
 *     [--out <path>]                  report path; a full run defaults to
 *                                     <repo>/evals/cut-chat.latest-report.json,
 *                                     a narrowed run writes only with --out
 *
 * Auth is the dev bypass header (scripts only — never the app), so runs are
 * dev-server-only and spend no credits. The spoken fixture is synthesized
 * locally with macOS `say`, so the transcript assertion is deterministic.
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
// includes what production runs (the routed pair).
const CANDIDATES: { label: string; simple: string; complex: string; gate: string }[] = [
  {
    label: "baseline",
    simple: geminiModelRoles.chatSimple,
    complex: geminiModelRoles.chat,
    gate: geminiModelRoles.fastDecision,
  },
  {
    label: "all-flash",
    simple: geminiModels.flash,
    complex: geminiModels.flash,
    gate: geminiModelRoles.fastDecision,
  },
  {
    label: "all-flashLite",
    simple: geminiModels.flashLite,
    complex: geminiModels.flashLite,
    gate: geminiModelRoles.fastDecision,
  },
];

const args = process.argv.slice(2);
const argValue = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const BASE = argValue("--base") ?? "http://localhost:3000";
const ONLY = argValue("--only");
const BUCKET = argValue("--bucket") as Bucket | undefined;
const RUNS = Number(argValue("--runs") ?? 1);
const MATRIX = args.includes("--matrix");
const NO_JUDGE = args.includes("--no-judge");
const ENFORCE_BUDGETS = args.includes("--enforce-budgets");
const OUT_ARG = argValue("--out");
const DEFAULT_OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../evals/cut-chat.latest-report.json"
);
// A narrowed run would overwrite the committed baseline with a partial
// report, so it only writes when --out names a destination.
const OUT = OUT_ARG ? resolve(OUT_ARG) : ONLY || BUCKET ? null : resolve(DEFAULT_OUT);

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
  const chatDesc =
    cfg.simpleModel === cfg.complexModel
      ? cfg.simpleModel
      : `${cfg.simpleModel} | complex→${cfg.complexModel}`;
  console.log(`\n== ${label}  chat=${chatDesc}  gate=${cfg.gateModel}`);
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
      if (r.trace.length > 0)
        console.log(`       tools: ${r.trace.map((t) => t.name).join(" → ")}`);
    }
    for (const r of runs.filter((r) => r.judgeNote)) console.log(`       judge: ${r.judgeNote}`);
  }
  return {
    label,
    chatModel: chatDesc,
    gateModel: cfg.gateModel,
    buckets: buildBucketSummaries(caseReports),
    cases: caseReports,
  };
}

async function main() {
  const audio = makeFixtureAudio();
  const only = ONLY?.split(",").map((s) => s.trim());
  const selected = cases(audio).filter(
    (c) => (!only || only.includes(c.name)) && (!BUCKET || c.bucket === BUCKET)
  );
  if (selected.length === 0)
    throw new Error(ONLY ? `No case named "${ONLY}".` : `No cases in bucket "${BUCKET}".`);

  // --model pins BOTH chat roles to one model (an unrouted config);
  // --simple-model / --complex-model override a role each. The default is
  // production's routed pair.
  const both = argValue("--model");
  const judgeModel = NO_JUDGE ? null : geminiModelRoles.fastDecision;
  const configs = MATRIX
    ? CANDIDATES.map((cand) => ({
        label: cand.label,
        cfg: {
          base: BASE,
          simpleModel: cand.simple,
          complexModel: cand.complex,
          gateModel: cand.gate,
          judgeModel,
        },
      }))
    : [
        {
          label: "config",
          cfg: {
            base: BASE,
            simpleModel: resolveModel(
              argValue("--simple-model") ?? both ?? geminiModelRoles.chatSimple
            ),
            complexModel: resolveModel(
              argValue("--complex-model") ?? both ?? geminiModelRoles.chat
            ),
            gateModel: resolveModel(argValue("--gate-model") ?? geminiModelRoles.fastDecision),
            judgeModel,
          },
        },
      ];

  const report: LatencyReport = {
    schema: "cut-chat-eval/v1",
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

  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nReport: ${OUT}`);
  }

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
