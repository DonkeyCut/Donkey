import { describe, expect, test } from "bun:test";
import { geminiChatPicks, geminiModelRoleNames, geminiModelRoles, resolveGeminiModel } from "./gemini-models";

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
