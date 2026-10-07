import type { UIMessage } from "ai";

/** A chat message's text parts, joined and trimmed. */
export function messageText(message: UIMessage): string {
  return message.parts.map((p) => (p.type === "text" ? p.text : "")).join("").trim();
}
