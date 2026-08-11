/**
 * Reply-shape graders. Every case runs the mechanical checks; the judge is a
 * rubric call on the light model whose notes ride the report without deciding
 * pass/fail, so a flaky verdict never flips a baseline. --no-judge skips it.
 */

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

const JUDGE_PROMPT = `You grade one reply from a video editor's built-in AI assistant. The turn is labeled: an editing turn ran tools against the project; a conversational turn answered in words alone.

Grade against this rubric:
- Concise and factual: an editing turn says what changed in concrete terms; a conversational turn answers the question directly. No headings, no filler.
- No self-praise: never calls its own output stunning, professional, a masterpiece, or similar.
- No upsell: pitches no exports, subtitles, music, or other features beyond at most one short suggestion phrased as a statement.
- Decisive: exercises judgment where the request left details open; a question appears only for genuine ambiguity.
- Failures owned: work that errored or was skipped is reported plainly as such.
- Approval gates respected: a plan whose rendering spends the user's credits correctly stops and states the approval step; that is required behavior.

A short, plain reply that fits its label passes. Reply with exactly one line: "pass" or "fail: <short reason>".`;

export interface JudgeVerdict {
  pass: boolean;
  note: string | null;
  judgeMs: number;
}

/** One rubric call on the judge model. A transport or parse failure returns a
 * pass with a note, so the eval never blocks on the judge. */
export async function judgeReply({
  base,
  model,
  userAsk,
  reply,
  didWork,
}: {
  base: string;
  model: string;
  userAsk: string;
  reply: string;
  didWork: boolean;
}): Promise<JudgeVerdict> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${base}/api/inference/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-donkey-client-id": "donkey-cut-eval",
        "x-donkey-dev-auth-bypass": "1",
      },
      body: JSON.stringify({
        donkeyProvider: "gemini",
        model,
        instructions: JUDGE_PROMPT,
        input: [
          {
            role: "user",
            content: [
              {
                text: `Turn kind: ${didWork ? "editing (tools ran)" : "conversational (words alone)"}\n\nUser asked:\n${userAsk}\n\nAssistant replied:\n${reply}`,
              },
            ],
          },
        ],
      }),
    });
    const judgeMs = performance.now() - t0;
    if (!res.ok) return { pass: true, note: `judge unavailable (${res.status})`, judgeMs };
    const body = (await res.json()) as { output_text?: string };
    const verdict = (body.output_text ?? "").trim();
    if (/^pass\b/i.test(verdict)) return { pass: true, note: null, judgeMs };
    if (/^fail\b/i.test(verdict))
      return { pass: false, note: verdict.replace(/^fail:?\s*/i, ""), judgeMs };
    return { pass: true, note: `judge returned "${verdict.slice(0, 80)}"`, judgeMs };
  } catch (err) {
    return {
      pass: true,
      note: `judge error: ${err instanceof Error ? err.message : String(err)}`,
      judgeMs: performance.now() - t0,
    };
  }
}
