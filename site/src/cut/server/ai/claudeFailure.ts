/** SDK failures can arrive as assistant messages without text stream events. */
export function claudeFailure(message: Record<string, unknown>): string | null {
  if (message.type === "assistant" && typeof message.error === "string") {
    const body = message.message as { content?: { type: string; text?: string }[] } | undefined;
    const detail = body?.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim();
    const action = message.error === "rate_limit"
      ? "Try again after your usage limit resets."
      : message.error === "authentication_failed" || message.error === "oauth_org_not_allowed"
        ? "Sign in to Claude again."
        : message.error === "billing_error"
          ? "Check your Claude billing."
          : "Try again in a moment.";
    return `Claude: ${detail || "The request failed."}\n\n${action}`;
  }
  if (message.type === "result" && message.subtype === "error_max_turns") return null;
  if (message.type === "result" && (message.is_error === true || (message.subtype !== "success" && message.subtype !== "error_max_turns"))) {
    const details = Array.isArray(message.errors) ? message.errors.filter((value): value is string => typeof value === "string").join("\n") : message.result;
    return `Claude: ${typeof details === "string" && details.trim() ? details.trim() : "The request failed."}\n\nTry again in a moment.`;
  }
  return null;
}
