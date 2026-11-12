import { describe, expect, test } from "bun:test";
import {
  RETIRED_GEMINI_ROLES,
  geminiChatPicks,
  geminiModelRoleNames,
  geminiModelRoles,
  resolveGeminiModel,
} from "./gemini-models";

// The page names a role; the route turns it into the registry's current id.
describe("model roles", () => {
  test("every role name resolves to its registry id", () => {
    for (const role of Object.values(geminiModelRoleNames)) {
      expect(resolveGeminiModel(role)).toBe(geminiModelRoles[role]);
    }
  });

  test("an id passes through unchanged", () => {
    expect(resolveGeminiModel(geminiModelRoles.chat)).toBe(geminiModelRoles.chat);
    expect(resolveGeminiModel("gemini-3.7-flash")).toBe("gemini-3.7-flash");
  });

  // A bundle built before a role retired still sends its name; the call runs
  // on the role that took over. Example: "chatPro" runs as the chat model.
  test("a retired role runs as the role that took over", () => {
    for (const [retired, role] of Object.entries(RETIRED_GEMINI_ROLES)) {
      expect(resolveGeminiModel(retired)).toBe(geminiModelRoles[role]);
    }
  });

  test("an object prototype key is not a role", () => {
    expect(resolveGeminiModel("toString")).toBe("toString");
  });
});

// The chat picker lists each Gemini model once, by role, under its own name.
describe("chat picks", () => {
  test("every pick runs a different model and has a name", () => {
    const ids = geminiChatPicks.map((pick) => geminiModelRoles[pick.role]);
    expect(new Set(ids).size).toBe(geminiChatPicks.length);
    for (const pick of geminiChatPicks) {
      expect(pick.label.length).toBeGreaterThan(0);
    }
  });
});
