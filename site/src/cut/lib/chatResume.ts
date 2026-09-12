import type { UIMessage } from "ai";

// A turn the page lost — a reload, a closed tab, a dropped connection, or a
// tool that needed the page while no tab was attached — resumes itself when
// the thread next opens. The panel reconnects to the engine's journal where
// one exists, and past that sends the model a continuation quoting the ask.

/** How many continuations one ask gets before the thread waits for the user. */
export const RESUME_LIMIT = 2;

/** The error a saved tool call settles to when the page died before its result landed. */
export const INTERRUPTED_ERROR = "Interrupted.";

/** What the engine answers for tools that need the page while no tab is
 * attached. A returning tab reads these off the finished reply and picks the
 * turn back up. */
export const DETACHED_UI_NOTE =
  "No editor page is attached to this session, so this tool had no effect. The project itself is unchanged — keep working from the editor state.";
export const DETACHED_MEDIA_ERROR =
  "This tool reads media through the editor page and is unavailable while no tab is attached. Work from the editor state instead.";
export const DETACHED_SESSION_ERROR =
  "This tool runs with the editor page's hosted sign-in and is unavailable while no tab is attached. Finish the edit from the project state; the user can run it from the editor.";

/** How the newest turn ended when it did not finish. Either way the thread
 * holds for the user; a turn with no verdict was cut off and resumes. */
export type TurnSettled = "stopped" | "failed";

export type ResumeMetadata = { resume: true; attachments?: unknown[] };

export function isResumeMessage(message: UIMessage): boolean {
  return message.role === "user" && (message.metadata as { resume?: boolean } | undefined)?.resume === true;
}

type ToolPart = { type: string; state?: string; errorText?: string; output?: unknown };

const isToolPart = (part: { type: string }): part is ToolPart =>
  part.type === "dynamic-tool" || part.type.startsWith("tool-");

/** A tool call the lost page never answered, or one that failed for want of a page. */
function lostToolCall(part: ToolPart): boolean {
  if (part.state === "output-error")
    return part.errorText === INTERRUPTED_ERROR || part.errorText === DETACHED_MEDIA_ERROR || part.errorText === DETACHED_SESSION_ERROR;
  if (part.state === "output-available")
    return !!part.output && typeof part.output === "object" && (part.output as { noEditor?: boolean }).noEditor === true;
  return false;
}

/** A reply that ran with no tab attached and hit a tool that needed one. */
export function detachedToolFailed(message: UIMessage): boolean {
  return message.parts.some((part) => isToolPart(part) && part.errorText !== INTERRUPTED_ERROR && lostToolCall(part));
}

/** The transcript with the lost turn's failure taken out, ready for the
 * continuation to finish the job in its place: the cut-off reply keeps only
 * the tool calls that landed, and a reply left with nothing goes entirely. */
export function scrubLostTurn(messages: UIMessage[], askId: string): UIMessage[] {
  const from = messages.findIndex((message) => message.id === askId);
  if (from < 0) return messages;
  return messages.flatMap((message, index) => {
    if (index <= from || message.role !== "assistant") return [message];
    const parts = message.parts.filter((part) => isToolPart(part) && part.state === "output-available" && !lostToolCall(part));
    return parts.length === 0 ? [] : [{ ...message, parts }];
  });
}

/** The ask the thread still owes a finished reply to; undefined once the
 * newest turn completed, or when the user stopped it or it failed outright. */
export function unfinishedAsk(
  messages: UIMessage[],
  completedMessageId: string | undefined,
  settled: TurnSettled | undefined,
): UIMessage | undefined {
  const last = messages.at(-1);
  const ask = messages.findLast((message) => message.role === "user" && !isResumeMessage(message));
  if (!last || !ask) return undefined;
  if (last.role === "assistant" && last.id === completedMessageId) return detachedToolFailed(last) ? ask : undefined;
  if (settled) return undefined;
  return ask;
}

export function askText(ask: UIMessage): string {
  return ask.parts.map((part) => (part.type === "text" ? part.text : "")).join("").trim();
}

/** The continuation a resumed turn opens with. It carries the ask itself, so
 * a provider session that never received it still knows the job. */
export function resumePrompt(ask: UIMessage): string {
  const text = askText(ask);
  return [
    "The editor page went away before your reply to this message finished:",
    "",
    text ? `"""\n${text}\n"""` : "(the message carried only attachments)",
    "",
    "Continue from where that turn stopped. The editor state below is current: edits that already landed are in it, renders still running show under `renders` (wait_for_renders lands them), and anything the ask needs that is missing you do now. Finish the ask, then reply as if this were one uninterrupted turn: say what is done, and say nothing about the page going away, a reload, or an interruption.",
  ].join("\n");
}
