import { describe, expect, test } from "bun:test";
import { claudeFailure } from "./claudeFailure";
import { turnClose } from "../../lib/turnBudget";

describe("Claude provider failures", () => {
  test("a non-streamed session limit preserves its reset time and gives an actionable error", () => {
    const failure = claudeFailure({
      type: "assistant", error: "rate_limit",
      message: { content: [{ type: "text", text: "You've hit your session limit · resets 11:30pm (Asia/Seoul)" }] },
    });
    expect(failure?.message).toBe("Claude: You've hit your session limit · resets 11:30pm (Asia/Seoul)\n\nTry again after your usage limit resets.");
    expect(failure?.code).toBe("claude_rate_limit");
    expect(failure?.params).toEqual({ detail: "You've hit your session limit · resets 11:30pm (Asia/Seoul)" });
    expect(turnClose({ end: failure ? "failed" : "done", spoke: false, extensions: 0 })).toBeNull();
  });
  test("authentication failures give the sign-in action", () => {
    const failure = claudeFailure({ type: "assistant", error: "authentication_failed", message: { content: [] } });
    expect(failure?.message).toBe("Claude: The request failed.\n\nSign in to Claude again.");
    expect(failure?.code).toBe("claude_sign_in");
    expect(failure?.params).toEqual({ detail: "" });
  });
  test("a success-shaped SDK error is still a failure", () => {
    expect(claudeFailure({ type: "result", subtype: "success", is_error: true, result: "Account limit reached" })?.message).toContain("Account limit reached");
  });
  test("execution failures preserve the SDK errors array", () => {
    expect(claudeFailure({ type: "result", subtype: "error_during_execution", errors: ["Connection closed"] })?.message).toBe("Claude: Connection closed\n\nTry again in a moment.");
  });
  test("ordinary replies and budget exhaustion retain their existing handling", () => {
    expect(claudeFailure({ type: "assistant", message: { content: [{ type: "text", text: "Done" }] } })).toBeNull();
    expect(claudeFailure({ type: "result", subtype: "success", is_error: false })).toBeNull();
    expect(claudeFailure({ type: "result", subtype: "error_max_turns", is_error: true })).toBeNull();
  });
});
