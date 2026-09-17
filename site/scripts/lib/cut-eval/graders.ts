/**
 * Reply-shape graders. Every case runs the mechanical checks; the judge is a
 * rubric call on the light model whose notes ride the report without deciding
 * pass/fail, so a flaky verdict never flips a baseline. --no-judge skips it.
 */

import { noul, score } from "../../../src/lib/inference/judge";

// Tag blocks that belong to the model's input. A reply carrying one is showing
// the user internal scaffolding.
const LEAKED_TAG = /<\/?(tools_ran|turn_ledger|editor_state|attached_assets)\b/i;

// Self-praise and handoff phrases the system prompt bans.
const BANNED_PHRASES = [
  "masterpiece",
  "stunning",
  "incredibly",
  "professional-grade",
  '"keep going"',
  "let me know if",
  "would you like me to",
];

export function replyShapeNotes(
  reply: string,
  opts: { mutated: boolean; expectsQuestion?: boolean }
): string[] {
  const notes: string[] = [];
  if (LEAKED_TAG.test(reply)) notes.push("reply leaks an input-side tag block");
  // A turn that legitimately ends on a question phrases it freely — the judge
  // still grades its tone.
  if (!opts.expectsQuestion) {
    const lower = reply.toLowerCase();
    const banned = BANNED_PHRASES.filter((p) => lower.includes(p));
    if (banned.length > 0) notes.push(`banned phrasing: ${banned.join(", ")}`);
    if (opts.mutated && reply.trim().endsWith("?"))
      notes.push("reply ends with a question after completed work");
  }
  return notes;
}

/** The rubric, one judged line each. A positive line passes at or above the
 * floor; a negative one (self-praise, upsell) passes below it. */
const RUBRIC = {
  concise_factual: {
    q: noul(
      "Is `reply` concise and factual — an editing turn says what changed in concrete terms, a conversational turn answers the question directly — with no headings and no filler?",
    ),
    wantYes: true,
  },
  self_praise: {
    q: noul("Does `reply` praise its own output — stunning, professional, a masterpiece, incredible, or similar?"),
    wantYes: false,
  },
  upsell: {
    q: noul(
      "Does `reply` pitch exports, subtitles, music, or other features beyond at most one short suggestion phrased as a statement?",
    ),
    wantYes: false,
  },
  decisive: {
    q: noul(
      "Does `reply` avoid asking the user a question the assistant could have decided itself? (Yes when it asks nothing, or asks only about a genuine ambiguity.)",
    ),
    wantYes: true,
  },
  failures_owned: {
    q: noul("Does `reply` report plainly any work that errored or was skipped, or was there nothing to own?", {
      true: "Every failure is stated as a failure, or nothing failed.",
      false: "A failure or a skipped step is hidden, softened, or described as done.",
    }),
    wantYes: true,
  },
  approval_gate: {
    q: noul(
      "When the turn produced a plan whose rendering spends the user's credits, does `reply` stop and state the approval step? (Yes when no such plan exists.)",
    ),
    wantYes: true,
  },
} as const;

const LENGTH = score("How long is `reply` for what it does?", [
  "Too short: a bare fragment that leaves the result unclear.",
  "Right: one to three sentences that say what happened.",
  "Long: a paragraph or more, restating, listing, or explaining beyond the ask.",
]);

const FLOOR = 0.5;

export interface JudgeVerdict {
  pass: boolean;
  note: string | null;
  judgeMs: number;
  /** Each rubric line's probability of yes, and the length score. */
  scores?: Record<string, number>;
}

/** One typed judgment over the reply. A transport failure returns a pass
 * with a note, so the eval never blocks on the judge. */
export async function judgeReply({
  base,
  userAsk,
  reply,
  didWork,
}: {
  base: string;
  userAsk: string;
  reply: string;
  didWork: boolean;
}): Promise<JudgeVerdict> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${base}/api/inference/judge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-donkey-client-id": "donkey-cut-eval",
        "x-donkey-dev-auth-bypass": "1",
      },
      body: JSON.stringify({
        state: {
          turnKind: didWork ? "editing (tools ran against the project)" : "conversational (words alone)",
          userAsk,
          reply,
        },
        questions: {
          ...Object.fromEntries(Object.entries(RUBRIC).map(([k, v]) => [k, v.q])),
          length: LENGTH,
        },
      }),
    });
    const judgeMs = performance.now() - t0;
    if (!res.ok) return { pass: true, note: `judge unavailable (${res.status})`, judgeMs };
    const body = (await res.json()) as {
      answers: Record<string, { type: string; noul?: number; score?: number }>;
    };
    const scores: Record<string, number> = {};
    const failing: string[] = [];
    for (const [k, v] of Object.entries(RUBRIC)) {
      const p = body.answers[k]?.noul ?? (v.wantYes ? 1 : 0);
      scores[k] = p;
      if (v.wantYes ? p < FLOOR : p >= FLOOR) failing.push(`${k.replace(/_/g, " ")} ${p.toFixed(2)}`);
    }
    const length = body.answers.length?.score;
    if (typeof length === "number") {
      scores.length = length;
      if (length >= 1.5) failing.push(`long ${length.toFixed(1)}`);
      if (length < 0.5) failing.push(`too short ${length.toFixed(1)}`);
    }
    return { pass: failing.length === 0, note: failing.length > 0 ? failing.join("; ") : null, judgeMs, scores };
  } catch (err) {
    return {
      pass: true,
      note: `judge error: ${err instanceof Error ? err.message : String(err)}`,
      judgeMs: performance.now() - t0,
    };
  }
}
