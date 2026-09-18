#!/usr/bin/env bun
/**
 * The clipping eval: which stretch of a long source is worth cutting a short
 * from.
 *
 * A talk is mostly material that only makes sense in place. Deciding which
 * few minutes of it stand on their own is a judgment about meaning, and the
 * whole feature rests on it being right — a clip that opens mid-answer or
 * stops mid-argument is worse than no clip. So the judgments are measured
 * here, one at a time against labelled excerpts, and then end to end over a
 * transcript whose good and flat stretches are known.
 *
 * The questions come from the tool's own module, so what is measured is what
 * ships. Thresholds come from the settings registry for the same reason.
 *
 * Runs against the judge adapter straight from the environment, so it needs
 * no server and spends no credits:
 *   bun run scripts/eval-cut-clip.ts [--only <substring>]
 *
 * Pass --base to go through the route instead, which exercises auth, billing
 * and the wire shape as well as the judgment. That path wants the site dev
 * server up with DONKEY_DEV_AUTH_BYPASS=1 (scripts only — never the app).
 */

import { SETTINGS } from "../src/lib/config/registry";
import { typesafeJudge } from "../src/lib/inference/adapters/typesafe";
import type { Entry, JudgeQuestion } from "../src/lib/inference/judge";
import { CLIP_QUESTIONS, findHighlights, type SpeechSegment } from "../src/cut/lib/highlights";

const args = process.argv.slice(2);
const argValue = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const BASE = argValue("--base");
const ONLY = argValue("--only");
const settings = SETTINGS.cutClip.default;

const judge = typesafeJudge();
if (!BASE && !judge.configured) {
  console.error("TYPESAFE_API_KEY is not set — run with --env-file=.env, or --base to go through the route.");
  process.exit(1);
}

/** The judge, reached the way the run asks for. Both paths carry the same
 * request and answer the same shape, so a case measures the judgment either
 * way; the route adds the session and the billing around it. */
const post = async (payload: unknown, signal?: AbortSignal): Promise<Response> => {
  if (BASE)
    return fetch(`${BASE}/api/inference/judge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-donkey-client-id": "donkey-cut-eval",
        "x-donkey-dev-auth-bypass": "1",
      },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    });
  const { state, questions } = payload as { state: Entry; questions: Record<string, JudgeQuestion> };
  const result = await judge.askJudge({ state, questions }, signal);
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

async function ask(state: unknown, questions: Record<string, unknown>) {
  const res = await post({ state, questions });
  if (!res.ok) throw new Error(`judge ${res.status}: ${await res.text()}`);
  return (await res.json()) as { answers: Record<string, { noul?: number; score?: number }> };
}

// ---------------------------------------------------------------------------
// One judgment at a time, over excerpts labelled by hand.

type Dimension = "alone" | "hook" | "lands";

interface Case {
  name: string;
  dimension: Dimension;
  said: string;
  /** Whether the answer has to sit above the middle. */
  want: boolean;
}

const cases: Case[] = [
  {
    name: "opens mid-answer",
    dimension: "alone",
    want: false,
    said:
      "Half is AI and half is hardware. And the second one is the one nobody expected, which is why we spent so long on it in the first place.",
  },
  {
    name: "answers a question nobody heard",
    dimension: "alone",
    want: false,
    said:
      "Yeah, exactly that. And I think he's right about it, which is why we changed how we do the interviews entirely.",
  },
  {
    name: "introduces its own subject",
    dimension: "alone",
    want: true,
    said:
      "America has largely lost its metal industry. It was hollowed out over the last few decades, and you cannot build anything physical without metal. So there is now a company rebuilding that supply chain from the ground up, and it is growing at software rates.",
  },
  {
    name: "a claim with its own evidence",
    dimension: "alone",
    want: true,
    said:
      "Hardware startups have gone from four percent of the batch to twenty percent in three years. The reason is that the tooling got cheap enough that two people in a garage can now do what took a factory floor.",
  },
  {
    name: "opens on throat-clearing",
    dimension: "hook",
    want: false,
    said:
      "So, um, yeah, I guess before we get into that, let me just say thanks for having me, it's great to be here. Anyway. The thing about manufacturing is that it takes capital.",
  },
  {
    name: "opens on a transition",
    dimension: "hook",
    want: false,
    said:
      "And that brings us to the next section, which we will come back to later on once we have covered the earlier material properly.",
  },
  {
    name: "opens on a number",
    dimension: "hook",
    want: true,
    said:
      "Eighteen percent of the founders we accepted this year had already shipped something people paid for. A year ago that was five percent.",
  },
  {
    name: "opens on a claim that demands the next line",
    dimension: "hook",
    want: true,
    said:
      "The most dangerous thing you can do as a founder is raise too much money too early. It buys you time to avoid the one conversation that would have saved the company.",
  },
  {
    name: "breaks off mid-argument",
    dimension: "lands",
    want: false,
    said:
      "There are three reasons this is happening. The first is that compute got cheap. The second is that the models got good enough to do the boring half of the work. And the third, which is really the",
  },
  {
    name: "trails into the next topic",
    dimension: "lands",
    want: false,
    said:
      "That inversion is the whole business, and it is why the incumbents cannot copy it. Anyway, we should probably move on, there is a lot to get through. The next few slides are mostly housekeeping, so I will go quickly. This one is the batch composition, which we publish every year.",
  },
  {
    name: "finishes the thought",
    dimension: "lands",
    want: true,
    said:
      "So the lesson is simple enough. Build the thing your first ten customers cannot live without, and ignore everyone else until those ten are happy.",
  },
];

/** The follows judgment: two moments cut together with the middle dropped. */
interface PairCase {
  name: string;
  A: string;
  B: string;
  want: boolean;
}

const pairs: PairCase[] = [
  {
    name: "the example after the claim",
    want: true,
    A: "Hardware startups have gone from four percent of the batch to twenty percent in three years.",
    B: "Take the metals company. Two founders, no factory, and they are already supplying three defense primes.",
  },
  {
    name: "two moments about different things",
    want: false,
    A: "Hardware startups have gone from four percent of the batch to twenty percent in three years.",
    B: "The caption font we use on the show is the same one we have used since the first episode, and people still write in about it.",
  },
];

// ---------------------------------------------------------------------------
// End to end, over a transcript whose stretches are known.

const line = (start: number, text: string): SpeechSegment => ({ start, end: start + 5, text });

/** Two minutes of talk: a flat opening, a strong self-contained middle, a
 * flat stretch, and a strong close. The pass has to find the two strong ones
 * and leave the filler. */
const transcript: SpeechSegment[] = [
  line(0, "So, um, thanks for having me, it's great to be back here again."),
  line(5, "We were just saying backstage that it has been, what, two years?"),
  line(10, "Yeah, something like that. Anyway, let's get into it."),
  line(15, "I think the first thing to say is that the slides are on the site afterwards."),
  line(20, "And if the audio cuts out, that's on us, not on you."),
  line(25, "Right. So."),
  line(30, "America has largely lost its metal industry."),
  line(35, "It was hollowed out over about thirty years, and you cannot build anything physical without metal."),
  line(40, "So a company is rebuilding that supply chain from the ground up."),
  line(45, "They are growing at software rates, which nobody thought a metals business could do."),
  line(50, "The reason is that they treated the order book as a software problem and the furnace as a detail."),
  line(55, "That inversion is the whole business, and it is why the incumbents cannot copy it."),
  line(60, "Anyway, we should probably move on, there is a lot to get through."),
  line(65, "The next few slides are mostly housekeeping, so I will go quickly."),
  line(70, "This one is the batch composition, which we publish every year."),
  line(75, "And this one is the same chart from last year for comparison."),
  line(80, "You can read those later, they are on the site."),
  line(85, "Okay. Here is the thing I actually want you to leave with."),
  line(90, "The most dangerous thing a founder can do is raise too much money too early."),
  line(95, "It buys you time to avoid the one conversation that would have saved the company."),
  line(100, "Every dead startup I have looked at had that conversation available to it and skipped it."),
  line(105, "So raise what you need to have it, and not a dollar more than that."),
  line(110, "That's the whole talk. Thank you."),
];

/** The one moment the pass must always come back with, and the stretch it must
 * never build a clip out of.
 *
 * Measured over every window this transcript offers, the lesson scores around
 * 0.79 on standing alone and 0.76 on landing, the filler around 0.53 and 0.35.
 * The metals stretch sits between them — it is exposition, and the judge is
 * right that it is the weaker moment — so it is not pinned here. Pinning a
 * middling moment would only measure which way the variance fell.
 */
const mustFind = [{ name: "the fundraising lesson", from: 85, to: 115 }];
const mustLeave = [{ name: "the housekeeping slides", from: 60, to: 85 }];

const overlaps = (a: { from: number; to: number }, b: { from: number; to: number }) =>
  a.from < b.to && b.from < a.to;
const shared = (a: { from: number; to: number }, b: { from: number; to: number }) =>
  Math.max(0, Math.min(a.to, b.to) - Math.max(a.from, b.from));

// ---------------------------------------------------------------------------

let failed = 0;
const report = (ok: boolean, name: string, detail: string) => {
  if (!ok) failed++;
  console.log(`[${ok ? "ok" : "FAIL"}] ${name.padEnd(42)} ${detail}`);
};

const wanted = (c: { name: string }) => !ONLY || c.name.includes(ONLY);

// 1. Each dimension, one excerpt at a time.
const picked = cases.filter(wanted);
if (picked.length > 0) {
  console.log("\nthe judgments, one excerpt at a time\n");
  const questions = Object.fromEntries(
    picked.map((c, i) => [`q::${i}`, CLIP_QUESTIONS[c.dimension](i)]),
  );
  const state = { variants: picked.map((c, i) => ({ i, seconds: 40, said: c.said })) };
  const { answers } = await ask(state, questions);
  picked.forEach((c, i) => {
    const p = answers[`q::${i}`]?.noul ?? 0;
    const ok = c.want ? p > 0.5 : p < 0.5;
    report(ok, `${c.dimension}: ${c.name}`, `${(p * 100).toFixed(0)}% (wanted ${c.want ? "yes" : "no"})`);
  });
}

// 2. The stitch.
const pickedPairs = pairs.filter(wanted);
if (pickedPairs.length > 0) {
  console.log("\ncutting two moments together\n");
  const questions = Object.fromEntries(
    pickedPairs.map((_, i) => [`pair::${i}`, CLIP_QUESTIONS.follows(i)]),
  );
  const state = { pairs: pickedPairs.map((p, i) => ({ i, A: p.A, B: p.B })) };
  const { answers } = await ask(state, questions);
  pickedPairs.forEach((c, i) => {
    const p = answers[`pair::${i}`]?.noul ?? 0;
    const ok = c.want ? p >= settings.followsFloor : p < settings.followsFloor;
    report(ok, `follows: ${c.name}`, `${(p * 100).toFixed(0)}% (floor ${settings.followsFloor})`);
  });
}

// 3. The whole pass, over a transcript whose stretches are known.
if (!ONLY) {
  console.log("\nthe whole pass over a talk\n");
  // Shorter than a real clip, so the bounds come down to fit this fixture.
  const local = { ...settings, minSeconds: 15, targetSeconds: 25, maxSeconds: 40, strideSeconds: 10, shortlist: 8 };
  const started = Date.now();
  const clips = await findHighlights(post as never, transcript, local, 2);
  const ms = Date.now() - started;
  report(clips.length > 0, "the pass returns moments", `${clips.length} in ${(ms / 1000).toFixed(1)}s`);

  for (const want of mustFind) {
    const hit = clips.some((c) => c.spans.some((sp) => overlaps(sp, want)));
    report(hit, `finds ${want.name}`, hit ? "picked" : `nothing overlapped ${want.from}-${want.to}s`);
  }
  // A clip that runs past a strong stretch into the flat one beside it has
  // clipped a second of filler, which is a bad edge. A clip that is MOSTLY
  // filler is the wrong moment, which is the failure worth pinning — the two
  // are different sizes of wrong, and only the second one wastes the clip.
  for (const skip of mustLeave) {
    const worst = Math.max(
      0,
      ...clips.map((c) => c.spans.reduce((n, sp) => n + shared(sp, skip), 0) / Math.max(c.seconds, 1)),
    );
    report(worst < 0.5, `no clip is mostly ${skip.name}`, `worst ${(worst * 100).toFixed(0)}% filler`);
  }

  // Structure: the spans are inside the bounds, in order, and never overlap.
  const spans = clips.flatMap((c) => c.spans);
  const bounded = spans.every((sp) => sp.to > sp.from);
  report(bounded, "every span runs forward", `${spans.length} spans`);
  const withinClip = clips.every((c) => c.seconds <= local.maxSeconds + 0.01);
  report(withinClip, "no clip runs past the ceiling", `longest ${Math.max(...clips.map((c) => c.seconds)).toFixed(1)}s`);
  const distinct = clips.every((a, i) =>
    clips.every((b, j) => i === j || !a.spans.some((x) => b.spans.some((y) => overlaps(x, y)))),
  );
  report(distinct, "the moments do not overlap each other", `${clips.length} clips`);
  const ordered = clips.every((c) => c.spans.every((sp, i) => i === 0 || sp.from >= c.spans[i - 1].to));
  report(ordered, "a stitched clip plays in source order", "checked");

  // The ranking has to put the real moment first. A clip carrying filler that
  // outranks the lesson would mean the composite is reading the wrong thing,
  // which no single pick-or-miss assertion catches.
  const best = clips.find((c) => c.spans.some((sp) => overlaps(sp, mustFind[0])));
  const fillerRanked = clips
    .filter((c) => c.spans.some((sp) => mustLeave.some((f) => overlaps(sp, f))))
    .map((c) => c.rank);
  const topped = !best || fillerRanked.every((r) => r < best.rank);
  report(topped, "nothing carrying filler outranks it", best ? `best ${best.rank.toFixed(2)}` : "not picked");

  for (const c of clips)
    console.log(
      `       [${c.rank.toFixed(2)}] ${c.spans.map((sp) => `${sp.from}-${sp.to}s`).join(" + ")} (${c.seconds}s)`,
    );
}

console.log(`\n${failed === 0 ? "all" : `${failed} of`} the clipping judgments ${failed === 0 ? "hold" : "missed"}`);
process.exit(failed ? 1 : 0);
