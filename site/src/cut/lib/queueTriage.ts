// Where a message sent mid-turn goes. A fast structured model call reads the
// running ask, what it has done so far, and the message, and names one of
// three places: fold (the running turn takes it in stride), spawn (a second
// thread runs it in parallel because the work cannot collide), or queue (it
// waits in the tray for the finished result). The page acts deterministically
// on the verdict, and a garbled or failed call reads as queue — the tray is
// the safe place, and it is exactly what the queue did before triage existed.

export type QueueVerdict = "fold" | "queue" | "spawn";

export interface TriageAnchor {
  /** The ask the running turn is working on. */
  ask: string;
  /** Tools the turn has run so far, in order, "name" or "name (running)". */
  progress: string[];
  /** Asks running in other threads of the same project right now. */
  elsewhere: string[];
}

export interface TriageRow {
  id: string;
  text: string;
}

/** The gate's instructions. */
export function queueTriagePrompt(): string {
  return `You triage messages a user sends to the AI editor built into a video editor while it is already working on an earlier ask. The running ask, the tools it has run so far, asks running in other chats of the same project, and any messages already waiting in the queue are given as context. Judge each message listed under "triage" on its own and place it:

fold — the working agent takes it in the same pass. The message refines, extends, narrows, corrects, or adds to the running ask ("also…", "and make it…", "actually…", "not that one", "bigger"), asks about the work in progress, or is another question when the running ask is a question. A further edit to the same items, the same job, or the same stretch of the timeline folds too: the agent already holds that context and does the extra piece after what is in flight.

spawn — a second agent runs it in parallel right now, because it is a different job on things nothing running touches: a question about the footage, a source, or the project that changes nothing; or an edit to other items than the running work's — the look, color, or volume of a different clip, a caption style, the music level, a project setting — whose timing the running work cannot move and that does not need its result. Being in the same video is no collision; the same items or the same job is.

queue — it waits for the running ask to finish and for a fresh view of the project: it needs the finished result (export, render, share, publish, a thumbnail or summary of the final cut), or it is sequenced after the running work ("then…", "after that…", "once it's done…", "when you're finished…"). Anything unclear.

Collisions on the timeline: while any running work — in this chat or another — cuts, trims, moves, splits, deletes, or reorders clips, the times of everything after the cuts shift. A message that places or times something on the timeline (a sticker at 12 seconds, a title at the end, a sound effect on a moment) collides with it: fold it when it belongs with this chat's running job, and queue it in every other case — never spawn it.

When unsure between fold and queue, queue. When unsure between spawn and queue, queue.`;
}

/** The gate's input, as plain text turns. Rows carry short ids the verdict
 * quotes back, so a long message can never be mistaken for another. */
export function queueTriageInput(
  anchor: TriageAnchor,
  waiting: TriageRow[],
  rows: TriageRow[]
): Record<string, unknown>[] {
  const clip = (s: string) => s.slice(0, 2000);
  const lines: string[] = [`Running ask:\n${clip(anchor.ask) || "(none)"}`];
  lines.push(
    `Tools run so far: ${anchor.progress.length > 0 ? anchor.progress.join(", ") : "(none yet)"}`
  );
  if (anchor.elsewhere.length > 0)
    lines.push(`Running in other chats:\n${anchor.elsewhere.map((a) => `- ${clip(a)}`).join("\n")}`);
  if (waiting.length > 0)
    lines.push(`Already waiting in the queue:\n${waiting.map((r) => `- ${clip(r.text)}`).join("\n")}`);
  lines.push(`Triage:\n${rows.map((r) => `[${r.id}] ${clip(r.text)}`).join("\n")}`);
  return [{ role: "user", content: [{ text: lines.join("\n\n") }] }];
}

/** The verdict's shape: one entry per triaged row. */
export const QUEUE_TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          verdict: { type: "string", enum: ["fold", "queue", "spawn"] },
        },
        required: ["id", "verdict"],
      },
    },
  },
  required: ["verdicts"],
} as const;

/** Deterministic read of the verdict. A row the reply skips, misnames, or
 * answers with anything but the three words stays in the queue. */
export function parseQueueTriage(
  outputText: string | undefined,
  rows: TriageRow[]
): Map<string, QueueVerdict> {
  const out = new Map<string, QueueVerdict>(rows.map((r) => [r.id, "queue"]));
  let parsed: unknown;
  try {
    parsed = JSON.parse(outputText ?? "");
  } catch {
    return out;
  }
  const verdicts = (parsed as { verdicts?: unknown } | null)?.verdicts;
  if (!Array.isArray(verdicts)) return out;
  for (const v of verdicts) {
    const id = (v as { id?: unknown })?.id;
    const verdict = (v as { verdict?: unknown })?.verdict;
    if (typeof id !== "string" || !out.has(id)) continue;
    if (verdict === "fold" || verdict === "spawn" || verdict === "queue") out.set(id, verdict);
  }
  return out;
}

/** The running turn's progress, read off the streaming assistant message's
 * parts: each tool it has called, finished ones by name and open ones marked. */
export function toolProgress(
  parts: readonly { type: string; state?: string; toolName?: string }[]
): string[] {
  return parts.flatMap((p) => {
    const name =
      p.type === "dynamic-tool"
        ? p.toolName
        : p.type.startsWith("tool-")
          ? p.type.slice(5)
          : undefined;
    if (!name) return [];
    return [p.state === "output-available" || p.state === "output-error" ? name : `${name} (running)`];
  });
}
