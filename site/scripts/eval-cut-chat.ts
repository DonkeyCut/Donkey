#!/usr/bin/env bun
/**
 * Behavior evals for the Cut assistant chat.
 *
 * Each case replays a real composer turn (system prompt, tool catalog,
 * <attached_assets>, <editor_state>, inline audio) against the live chat
 * model through the hosted Responses route and asserts on what the model
 * does: questions get answered in chat without project-mutating tool calls,
 * edit requests still reach for tools.
 *
 * Run with the site dev server up:
 *   bun run scripts/eval-cut-chat.ts [--base http://localhost:3000] [--only <case>] [--runs N]
 *
 * Auth is the dev bypass header (scripts only — never the app), so runs are
 * dev-server-only and spend no credits. The spoken fixture is synthesized
 * locally with macOS `say`, so the transcript assertion is deterministic.
 *
 * The cases, fixtures, and runner live in scripts/lib/cut-eval/ and are shared
 * with the latency eval (eval-cut-latency.ts).
 */

import { cases } from "./lib/cut-eval/cases";
import { makeFixtureAudio } from "./lib/cut-eval/fixtures";
import { defaultRunConfig, runCase } from "./lib/cut-eval/harness";

const args = process.argv.slice(2);
const argValue = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const BASE = argValue("--base") ?? "http://localhost:3000";
const ONLY = argValue("--only");
const RUNS = Number(argValue("--runs") ?? 1);

async function main() {
  const audio = makeFixtureAudio();
  const all = cases(audio).filter((c) => !ONLY || c.name === ONLY);
  if (all.length === 0) throw new Error(`No case named "${ONLY}".`);
  const cfg = defaultRunConfig(BASE);

  let failed = 0;
  for (const c of all) {
    for (let run = 1; run <= RUNS; run++) {
      const label = RUNS > 1 ? `${c.name} [${run}/${RUNS}]` : c.name;
      try {
        const r = await runCase(c, cfg);
        const names = r.trace.map((t) => t.name);
        const tools =
          names.length > 0
            ? ` tools: ${names.join(" → ")}`
            : r.intent === "chat"
              ? " tools: none (gated)"
              : " tools: none";
        if (r.pass) {
          console.log(`PASS ${label}${tools}`);
        } else {
          failed++;
          console.log(`FAIL ${label}${tools}`);
          for (const n of r.notes) console.log(`     - ${n}`);
          console.log(`     reply: ${r.reply.slice(0, 200) || "(empty)"}`);
        }
      } catch (err) {
        failed++;
        console.log(`FAIL ${label} — ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  if (failed > 0) {
    console.log(`\n${failed} failure(s).`);
    process.exit(1);
  }
  console.log("\nAll cases passed.");
}

void main();
