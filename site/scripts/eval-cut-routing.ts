#!/usr/bin/env bun
/**
 * The Cut routing eval: what the turn judge decides for a labelled set of
 * asks — the skill it attaches, the tool areas it declares, the gate side —
 * and how the thresholds in the `cutJudge` setting trade suggestion
 * accuracy against declared tool count.
 *
 * Every case is judged once (the answers are cached for the run), then the
 * route is composed under a grid of thresholds in code, so a sweep costs no
 * extra calls. The report names the best triple; the registry defaults are
 * set from it.
 *
 * Run with the site dev server up:
 *   bun run scripts/eval-cut-routing.ts
 *     [--base http://localhost:3000]
 *     [--only <substring>]            cases whose request contains it
 *     [--no-sweep]                    defaults only
 *     [--filler]                      also judge the filler-word fixture
 *
 * Auth is the dev bypass header (scripts only — never the app), so runs are
 * dev-server-only and spend no credits.
 */

import { SETTINGS } from "../src/lib/config/registry";
import { noul } from "../src/lib/inference/judge";
import { AI_SKILL_INDEX, areaTools, CORE_TOOLS, TOOL_AREA_NAMES } from "../src/cut/server/ai/catalog";
import { judgeTurnState, pickSkill, routeTurn, TURN_JUDGE_QUESTIONS, type TurnJudgeAnswers } from "../src/cut/lib/turnJudge";
import { EDITOR_STATE, FILLER_CUES } from "./lib/cut-eval/fixtures";
import { routingCases, type RoutingCase } from "./lib/cut-eval/routingCases";

const args = process.argv.slice(2);
const argValue = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const BASE = argValue("--base") ?? "http://localhost:3000";
const ONLY = argValue("--only");
const SWEEP = !args.includes("--no-sweep");
const FILLER = args.includes("--filler");

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
  return (await res.json()) as { answers: Record<string, { type: string; noul?: number; choice?: string; confidence?: number }>; usage: { input_tokens: number } };
}

function messagesFor(c: RoutingCase) {
  const recent = (c.recent ?? []).map((t, i) => ({ id: `r${i}`, role: t.role, parts: [{ type: "text", text: t.text }] }));
  return [...recent, { id: "ask", role: "user", parts: [{ type: "text", text: c.request }] }] as never;
}

interface Judged {
  c: RoutingCase;
  answers: TurnJudgeAnswers;
  ms: number;
  tokens: number;
}

interface Summary {
  skillWrong: number;
  skillNeedless: number;
  skillMissed: number;
  areaMisses: number;
  intentWrong: number;
  meanTools: number;
}

function summarize(judged: Judged[], settings: typeof SETTINGS.cutJudge.default): Summary {
  let skillWrong = 0;
  let skillNeedless = 0;
  let skillMissed = 0;
  let areaMisses = 0;
  let intentWrong = 0;
  let tools = 0;
  for (const j of judged) {
    const r = routeTurn(j.answers, settings);
    const skill = pickSkill(j.answers, settings);
    const ok = skillMatches(j.c, skill);
    if (!ok && skill && j.c.skill) skillWrong++;
    if (!ok && skill && !j.c.skill) skillNeedless++;
    if (!ok && !skill) skillMissed++;
    if (j.c.areas.some((a) => !r.areas.includes(a))) areaMisses++;
    if (j.c.intent && r.intent !== j.c.intent) intentWrong++;
    tools += r.intent === "chat" ? 0 : CORE_TOOLS.length + areaTools(r.areas).length;
  }
  return {
    skillWrong,
    skillNeedless,
    skillMissed,
    areaMisses,
    intentWrong,
    meanTools: Math.round(tools / Math.max(1, judged.length)),
  };
}

const skillMatches = (c: RoutingCase, skill: string | null) =>
  Array.isArray(c.skill) ? c.skill.includes(skill) : skill === c.skill;

const pct = (n: number, d: number) => `${Math.round((100 * n) / Math.max(1, d))}%`;

async function main() {
  const selected = routingCases.filter((c) => !ONLY || c.request.includes(ONLY));
  if (selected.length === 0) throw new Error(`No case matching "${ONLY}".`);
  const defaults = SETTINGS.cutJudge.default;
  console.log(`== routing  cases=${selected.length}  skills=${AI_SKILL_INDEX.length}  areas=${TOOL_AREA_NAMES.length}`);

  const judged: Judged[] = [];
  for (const c of selected) {
    const t0 = performance.now();
    const state = judgeTurnState(messagesFor(c), EDITOR_STATE);
    const { answers, usage } = await judge(state, TURN_JUDGE_QUESTIONS);
    const j: Judged = { c, answers: answers as unknown as TurnJudgeAnswers, ms: performance.now() - t0, tokens: usage.input_tokens };
    judged.push(j);
    const r = routeTurn(j.answers, defaults);
    const skill = pickSkill(j.answers, defaults);
    const skillOk = skillMatches(c, skill);
    const areasOk = c.areas.every((a) => r.areas.includes(a));
    const intentOk = !c.intent || r.intent === c.intent;
    const mark = skillOk && areasOk && intentOk ? "ok  " : "MISS";
    console.log(
      `  ${mark} ${c.request.slice(0, 60).padEnd(60)}  ${r.intent.padEnd(7)}  skill=${String(skill).padEnd(22)}  areas=${r.areas.length}  ${Math.round(j.ms)}ms`,
    );
    if (!skillOk) {
      const a = j.answers;
      const gate = a.needs_reference.noul.toFixed(2);
      const fit = skill ? (a[`fits::${skill}`] as { noul?: number })?.noul?.toFixed(2) : "-";
      console.log(`       skill: expected ${String(c.skill)}, got ${skill}  needs_reference=${gate}  choice=${a.skill.choice}@${a.skill.confidence.toFixed(2)} fit=${fit}`);
    }
    if (!areasOk) console.log(`       areas: missing ${c.areas.filter((a) => !r.areas.includes(a)).join(", ")} (got ${r.areas.join(", ") || "none"})`);
    if (!intentOk) console.log(`       intent: expected ${c.intent}, got ${r.intent}`);
  }

  const ms = judged.map((j) => j.ms).sort((a, b) => a - b);
  const p50 = ms[Math.floor(ms.length / 2)];
  const meanTokens = Math.round(judged.reduce((s, j) => s + j.tokens, 0) / judged.length);
  const d = summarize(judged, defaults);
  console.log(`\n== defaults  skillGate=${defaults.skillGate} skillFits=${defaults.skillFits} toolArea=${defaults.toolArea}`);
  console.log(
    `  skill wrong ${pct(d.skillWrong, judged.length)}  needless ${pct(d.skillNeedless, judged.length)}  missed ${pct(d.skillMissed, judged.length)}` +
      `  area misses ${pct(d.areaMisses, judged.length)}  intent wrong ${pct(d.intentWrong, judged.length)}  mean tools ${d.meanTools}` +
      `  judge p50 ${Math.round(p50)}ms  mean input tokens ${meanTokens}`,
  );

  if (SWEEP) {
    const grid = { skillGate: [0.2, 0.3, 0.4, 0.5], skillFits: [0.2, 0.3, 0.4, 0.5], toolArea: [0.15, 0.2, 0.25, 0.3, 0.4, 0.5] };
    const rows: { s: typeof defaults; r: Summary }[] = [];
    for (const skillGate of grid.skillGate)
      for (const skillFits of grid.skillFits)
        for (const toolArea of grid.toolArea) {
          const s = { ...defaults, skillGate, skillFits, toolArea };
          rows.push({ s, r: summarize(judged, s) });
        }
    // Misses cost more than tokens: order by area misses, then wrong or
    // needless skills, then missed skills, then the declared count.
    rows.sort(
      (a, b) =>
        a.r.areaMisses - b.r.areaMisses ||
        a.r.skillWrong + a.r.skillNeedless - (b.r.skillWrong + b.r.skillNeedless) ||
        a.r.skillMissed - b.r.skillMissed ||
        a.r.meanTools - b.r.meanTools,
    );
    console.log(`\n== sweep (best first)`);
    for (const { s, r } of rows.slice(0, 8))
      console.log(
        `  gate=${s.skillGate} fits=${s.skillFits} area=${s.toolArea}  area misses ${r.areaMisses}  skill wrong ${r.skillWrong} needless ${r.skillNeedless} missed ${r.skillMissed}  mean tools ${r.meanTools}`,
      );
  }

  if (FILLER) {
    console.log(`\n== filler words`);
    const words = FILLER_CUES.flatMap((c) => c.words.map((w, i) => ({ key: `word::${c.id}::${i}`, cueId: c.id, i, w: w.w })));
    const questions = Object.fromEntries(
      words.map((w) => [
        w.key,
        noul(
          `In \`cues\`, is word ${w.i} of cue "${w.cueId}" a disfluency or false start a careful editor would cut out of the speech — an um, uh, er, hmm; a stranded "like", "you know", "I mean", "sort of"; a stutter or an immediately repeated word — judged in the sentence it sits in?`,
        ),
      ]),
    );
    const state = { cues: FILLER_CUES.map((c) => ({ id: c.id, text: c.text, words: c.words.map((w, i) => ({ i, w: w.w })) })) };
    const { answers } = await judge(state, questions);
    for (const w of words) {
      const p = answers[w.key]?.noul ?? 0;
      console.log(`  ${p >= defaults.fillerCut ? "CUT " : "keep"} ${w.w.padEnd(12)} ${p.toFixed(2)}`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
