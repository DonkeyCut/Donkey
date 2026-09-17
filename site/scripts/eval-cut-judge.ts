#!/usr/bin/env bun
/**
 * The provider-failure eval: what a hosted provider's error means.
 *
 * A render or a music call fails, and the next step turns on why. The
 * content declined means the ladder may drop to its text-only rung and a
 * music prompt is worth rewriting; a timeout means neither. That reading is a
 * judgment over the provider's own error text, so it is measured here against
 * errors real providers returned.
 *
 * Run with the site dev server up:
 *   bun run scripts/eval-cut-judge.ts [--base http://localhost:3000] [--only <substring>]
 *
 * Auth is the dev bypass header (scripts only — never the app), so runs are
 * dev-server-only and spend no credits.
 */

import { PROVIDER_FAILURE_QUESTION, providerFailureClass, type ProviderFailureClass } from "../src/cut/lib/providerFailure";

const args = process.argv.slice(2);
const argValue = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const BASE = argValue("--base") ?? "http://localhost:3000";
const ONLY = argValue("--only");

interface FailureCase {
  /** What the case pins, in the words of the decision it drives. */
  name: string;
  /** The provider's error text, as it reached us. */
  error: string;
  want: ProviderFailureClass;
}

const cases: FailureCase[] = [
  {
    name: "person-policy refusal",
    error:
      "The input image contains content that has been blocked by your current safety settings for person/face generation. Support codes: 17301594",
    want: "content_refused",
  },
  {
    name: "unreadable anchor format",
    error: "Unsupported image format. Expected JPEG or PNG.",
    want: "content_refused",
  },
  {
    name: "filtered render came back empty",
    error: "Omni returned no video for this request.",
    want: "content_refused",
  },
  {
    name: "prompt blocked before the render",
    error: "The prompt was blocked by the safety filter (PROHIBITED_CONTENT).",
    want: "content_refused",
  },
  {
    name: "render ran out of time",
    error: "The video render is taking too long — try again.",
    want: "transient_failure",
  },
  {
    name: "the model was overloaded",
    error: "503 The model is overloaded. Please try again later.",
    want: "transient_failure",
  },
  {
    name: "rate limited",
    error: "429 Resource has been exhausted (e.g. check quota).",
    want: "transient_failure",
  },
  {
    name: "a bad request names no cause",
    error: "400 Invalid JSON payload received. Unknown name \"durationSecond\".",
    want: "other",
  },
  {
    name: "an internal error names no cause",
    error: "500 Internal error encountered.",
    want: "other",
  },
];

async function judgeFailure(error: string): Promise<{ cls: ProviderFailureClass; confidence: number; ms: number }> {
  const started = Date.now();
  const res = await fetch(`${BASE}/api/inference/judge`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-donkey-client-id": "donkey-cut-eval",
      "x-donkey-dev-auth-bypass": "1",
    },
    body: JSON.stringify({ state: { error }, questions: { cause: PROVIDER_FAILURE_QUESTION } }),
  });
  if (!res.ok) throw new Error(`judge ${res.status}: ${await res.text()}`);
  const { answers } = (await res.json()) as {
    answers: { cause: { choice: ProviderFailureClass; confidence: number } };
  };
  return { cls: providerFailureClass(answers.cause), confidence: answers.cause.confidence, ms: Date.now() - started };
}

const picked = cases.filter((c) => !ONLY || c.name.includes(ONLY) || c.error.includes(ONLY));
let failed = 0;
for (const c of picked) {
  const { cls, confidence, ms } = await judgeFailure(c.error);
  const ok = cls === c.want;
  if (!ok) failed++;
  console.log(
    `[${ok ? "ok" : "FAIL"}] ${c.name.padEnd(34)} ${cls}${ok ? "" : ` (wanted ${c.want})`} · ${(confidence * 100).toFixed(0)}% · ${ms}ms`,
  );
  if (!ok) console.log(`       ${c.error}`);
}

console.log(`\n${picked.length - failed}/${picked.length} classified as they must be`);
process.exit(failed ? 1 : 0);
