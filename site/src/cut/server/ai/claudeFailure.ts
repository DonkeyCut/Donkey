import { UserError } from "../../lib/userError";

// What the person reads when Claude fails: the provider's own words (the
// `detail` value, empty when it sent none) and the step that fixes it. Each
// code has a message in the errors catalog, so the panel
// words it in the page's language; the English message stays for the stream
// and the logs.

/** The failure codes, by what the person does next. */
const FAILURE_ACTIONS = {
  claude_rate_limit: "Try again after your usage limit resets.",
  claude_sign_in: "Sign in to Claude again.",
  claude_billing: "Check your Claude billing.",
  claude_failed: "Try again in a moment.",
} as const;

type FailureCode = keyof typeof FAILURE_ACTIONS;

const REQUEST_FAILED = "The request failed.";

function failure(code: FailureCode, detail: string): UserError {
  return new UserError(code, `Claude: ${detail || REQUEST_FAILED}\n\n${FAILURE_ACTIONS[code]}`, { detail });
}

/** The code for an assistant message's SDK error. */
function errorCode(error: string): FailureCode {
  if (error === "rate_limit") {
    return "claude_rate_limit";
  }
  if (error === "authentication_failed" || error === "oauth_org_not_allowed") {
    return "claude_sign_in";
  }
  if (error === "billing_error") {
    return "claude_billing";
  }
  return "claude_failed";
}

/** SDK failures can arrive as assistant messages without text stream events. */
export function claudeFailure(message: Record<string, unknown>): UserError | null {
  if (message.type === "assistant" && typeof message.error === "string") {
    const body = message.message as { content?: { type: string; text?: string }[] } | undefined;
    const detail = body?.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim();
    return failure(errorCode(message.error), detail ?? "");
  }
  if (message.type === "result" && message.subtype === "error_max_turns") return null;
  if (message.type === "result" && (message.is_error === true || (message.subtype !== "success" && message.subtype !== "error_max_turns"))) {
    const details = Array.isArray(message.errors) ? message.errors.filter((value): value is string => typeof value === "string").join("\n") : message.result;
    return failure("claude_failed", typeof details === "string" ? details.trim() : "");
  }
  return null;
}
