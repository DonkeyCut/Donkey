// The chat harness's understanding boundary for one composer turn: a fast
// structured model call judges the newest user message — does it ask for
// anything, and how big is the job — and the harness gates and routes
// deterministically on the verdict. A "chat" turn (greeting, thanks — social
// filler that requests nothing) runs with no tool declarations at all, so
// unsolicited edits are impossible by construction. A "simple" turn (one
// self-contained ask) runs on the light chat model; a "complex" turn (a
// composed job) runs on the full one.

export type TurnIntent = "chat" | "simple" | "complex";

export const TURN_INTENT_PROMPT = `You gate and route the tools of an AI assistant built into a video editor. Read the conversation and judge only its newest user message.

Reply with exactly one word:
chat — pure social filler (a greeting, thanks, a sign-off, an acknowledgement) that requests nothing.
simple — one self-contained ask: a single edit, a single generation, or a question to answer. Terse follow-ups ("yes", "do it", "the second one") that confirm one pending action are simple.
complex — a composed job: several edits across the timeline, cutting or reorganizing many clips, assembling media into a cut, or anything needing a plan across steps.

If unsure between chat and the others, reply simple. If unsure between simple and complex, reply complex.`;

/** The conversation as plain text turns for the classifier — recent turns ride
 * along so follow-ups keep their referent, and each is capped so a pasted wall
 * of text can't blow the call's budget. */
export function turnIntentInput(
  turns: { role: "user" | "assistant"; text: string }[]
): Record<string, unknown>[] {
  return turns
    .filter((t) => t.text)
    .slice(-6)
    .map((t) => ({ role: t.role, content: [{ text: t.text.slice(0, 2000) }] }));
}

/** Deterministic read of the classifier's one-word verdict. Only a clear
 * "chat" withholds tools, and only a clear "simple" takes the light model —
 * a garbled reply runs the full model with tools, so a classifier hiccup
 * never blocks or downgrades a real request. */
export function parseTurnIntent(outputText: string | undefined): TurnIntent {
  const t = (outputText ?? "").trim();
  if (/^\W*chat\b/i.test(t)) return "chat";
  if (/^\W*simple\b/i.test(t)) return "simple";
  return "complex";
}
