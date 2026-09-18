#!/usr/bin/env bun
/**
 * The Cut instant-path eval: for a labelled set of asks, which one the
 * judgment settles into a tool call with no model round, and whether that
 * call is the right one.
 *
 * Every case is judged once and the composition is replayed under a grid of
 * floors in code, so the sweep costs no extra calls. The report names the
 * best set; the `cutJudge` registry defaults are set from it.
 *
 * Two kinds of mistake, and they do not cost the same. A WRONG call edits
 * the project without asking, so it is the one to drive to zero; a MISS
 * only falls through to today's chat loop, which handles it correctly and
 * slowly. The sweep orders on wrong first, then coverage.
 *
 * Run with the site dev server up:
 *   bun run scripts/eval-cut-instant.ts
 *     [--base http://localhost:3000]
 *     [--only <substring>]   cases whose request contains it
 *     [--no-sweep]           defaults only
 *
 * Auth is the dev bypass header (scripts only — never the app), so runs are
 * dev-server-only and spend no credits.
 */

import { SETTINGS } from "../src/lib/config/registry";
import {
  availableActions,
  instantAction,
  instantQuestions,
  instantResolve,
  instantSnapshot,
  instantState,
  type InstantAnswers,
  type ResolvedAction,
} from "../src/cut/lib/instantAction";
import { instantCases, INSTANT_STATE, type InstantCase } from "./lib/cut-eval/instantCases";

const args = process.argv.slice(2);
const argValue = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const BASE = argValue("--base") ?? "http://localhost:3000";
const ONLY = argValue("--only");
const SWEEP = !args.includes("--no-sweep");

const defaults = SETTINGS.cutJudge.default;
type Settings = typeof defaults;

async function judge(state: unknown, questions: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/inference/judge`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-donkey-client-id": "donkey-cut-eval",
      "x-donkey-dev-auth-bypass": "1",
    },
    body: JSON.stringify({ state, questions }),
  });
  if (!res.ok) throw new Error(`judge ${res.status}: ${await res.text()}`);
  return (await res.json()) as { answers: InstantAnswers; usage: { input_tokens: number } };
}

function messagesFor(c: InstantCase) {
  const recent = (c.recent ?? []).map((t, i) => ({ id: `r${i}`, role: t.role, parts: [{ type: "text", text: t.text }] }));
  return [...recent, { id: "ask", role: "user", parts: [{ type: "text", text: c.request }] }] as never;
}

/** Whether a resolved call is the one the case labelled. Arguments are
 * checked as a subset, and a number within the case's tolerance counts. */
function matches(c: InstantCase, got: ResolvedAction | null): boolean {
  if (c.tool === null) return got === null;
  if (!got || got.tool !== c.tool) return false;
  for (const [k, want] of Object.entries(c.args ?? {})) {
    const have = got.args[k];
    if (typeof want === "number" && typeof have === "number") {
      if (Math.abs(have - want) > (c.tol ?? 0.001)) return false;
    } else if (have !== want) return false;
  }
  return true;
}

interface Judged {
  c: InstantCase;
  answers: InstantAnswers;
  ms: number;
  tokens: number;
}

interface Summary {
  /** An edit the path would have made that the case says is wrong. */
  wrong: number;
  /** An instant case that fell through to the loop. */
  missed: number;
  /** An instant case carried out correctly. */
  hit: number;
  /** Cases that must take the loop and did. */
  held: number;
}

/** The candidates every case is judged against. One project, one snapshot —
 * and the sweep re-composes thousands of times, so it is built once. */
const SNAP = instantSnapshot(INSTANT_STATE);

function summarize(judged: Judged[], settings: Settings): Summary {
  const s: Summary = { wrong: 0, missed: 0, hit: 0, held: 0 };
  for (const j of judged) {
    const got = instantAction(j.answers, SNAP, settings);
    if (j.c.tool === null) {
      if (got === null) s.held++;
      else s.wrong++;
    } else if (got === null) s.missed++;
    else if (matches(j.c, got)) s.hit++;
    else s.wrong++;
  }
  return s;
}

const pct = (n: number, d: number) => `${Math.round((100 * n) / Math.max(1, d))}%`;

async function main() {
  const selected = instantCases.filter((c) => !ONLY || c.request.includes(ONLY));
  if (selected.length === 0) throw new Error(`No case matching "${ONLY}".`);
  const snap = SNAP;
  const questions = instantQuestions(snap);
  console.log(
    `== instant  cases=${selected.length}  actions=${availableActions(snap).length}  questions=${Object.keys(questions).length}`,
  );

  const judged: Judged[] = [];
  for (const c of selected) {
    const t0 = performance.now();
    const { answers, usage } = await judge(instantState(messagesFor(c), INSTANT_STATE), questions);
    const j: Judged = { c, answers, ms: performance.now() - t0, tokens: usage.input_tokens };
    judged.push(j);
    const { action: got, shortfall } = instantResolve(answers, snap, defaults);
    const ok = matches(c, got);
    const shown = got ? `${got.tool}(${JSON.stringify(got.args)})` : "—";
    console.log(
      `  ${ok ? "ok  " : c.tool === null ? "WRONG" : got ? "WRONG" : "miss"} ${c.request.slice(0, 46).padEnd(46)}  ${shown.slice(0, 62).padEnd(62)}  ${Math.round(j.ms)}ms`,
    );
    if (!ok) {
      const pick = answers.action as { choice: string; probabilities: Record<string, number> };
      console.log(
        `       wanted ${c.tool ?? "the loop"}${c.args ? ` ${JSON.stringify(c.args)}` : ""}` +
          `  action=${pick.choice}@${(pick.probabilities[pick.choice] ?? 0).toFixed(2)}` +
          (shortfall.length > 0 ? `  short: ${shortfall.join(" ")}` : ""),
      );
    }
  }

  const ms = judged.map((j) => j.ms).sort((a, b) => a - b);
  const p50 = ms[Math.floor(ms.length / 2)];
  const p90 = ms[Math.floor(ms.length * 0.9)];
  const meanTokens = Math.round(judged.reduce((s, j) => s + j.tokens, 0) / judged.length);
  const d = summarize(judged, defaults);
  const instantCount = judged.filter((j) => j.c.tool !== null).length;
  console.log(
    `\n== defaults  floor=${defaults.instantFloor} target=${defaults.instantTarget} enum=${defaults.instantEnum}` +
      ` level=${defaults.instantLevel} bool=${defaults.instantBool} exact=${defaults.instantExact} multi=${defaults.instantMulti} leftover=${defaults.instantLeftover} remake=${defaults.instantRemake}`,
  );
  console.log(
    `  wrong ${d.wrong}  hit ${d.hit}/${instantCount} (${pct(d.hit, instantCount)})  missed ${d.missed}` +
      `  held ${d.held}/${judged.length - instantCount}  judge p50 ${Math.round(p50)}ms p90 ${Math.round(p90)}ms  mean input tokens ${meanTokens}`,
  );

  if (SWEEP) {
    const grid = {
      instantFloor: [0.3, 0.4, 0.5, 0.6, 0.7],
      instantTarget: [0.3, 0.4, 0.5, 0.6],
      instantEnum: [0.3, 0.4, 0.5],
      instantExact: [0.3, 0.4, 0.5, 0.6],
      instantMulti: [0.3, 0.4, 0.5, 0.6],
      instantRemake: [0.2, 0.3, 0.4, 0.5],
      instantLeftover: [0.3, 0.4, 0.5],
    };
    const rows: { s: Settings; r: Summary }[] = [];
    for (const instantFloor of grid.instantFloor)
      for (const instantTarget of grid.instantTarget)
        for (const instantEnum of grid.instantEnum)
          for (const instantExact of grid.instantExact)
            for (const instantMulti of grid.instantMulti)
              for (const instantRemake of grid.instantRemake)
                for (const instantLeftover of grid.instantLeftover) {
                const s = { ...defaults, instantFloor, instantTarget, instantEnum, instantExact, instantMulti, instantRemake, instantLeftover };
                rows.push({ s, r: summarize(judged, s) });
              }
    // A wrong edit costs far more than a fall-through, so it orders first,
    // then coverage, then the tightest floors that still reach it — of two
    // settings that score the same, the stricter one is the one to ship,
    // because it is the one that also holds on an ask this set never saw.
    const tightness = (s: Settings) => s.instantFloor + s.instantTarget + s.instantEnum - s.instantExact - s.instantMulti - s.instantRemake - s.instantLeftover;
    rows.sort((a, b) => a.r.wrong - b.r.wrong || b.r.hit - a.r.hit || tightness(b.s) - tightness(a.s));
    console.log(`\n== sweep (best first)`);
    for (const { s, r } of rows.slice(0, 10))
      console.log(
        `  floor=${s.instantFloor} target=${s.instantTarget} enum=${s.instantEnum} exact=${s.instantExact} multi=${s.instantMulti} leftover=${s.instantLeftover}` +
          `  wrong ${r.wrong}  hit ${r.hit}/${instantCount}  missed ${r.missed}  held ${r.held}`,
      );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
