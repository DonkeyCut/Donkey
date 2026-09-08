import { describe, expect, test } from "bun:test";
import { throws } from "node:assert/strict";
import { AI_MODELS, aiModelProvider, type AiModel } from "@/cut/lib/aiModels";
import { geminiModelRoleNames } from "@/lib/inference/gemini-models";

describe("chat model providers", () => {
  for (const model of AI_MODELS) {
    test(`routes ${model.label} to ${model.provider}`, () => {
      expect(aiModelProvider(model.id)).toBe(model.provider);
    });
  }

  test("Gemini is usable when the browser has no local engine", () => {
    const providers: Record<AiModel["provider"], { available: boolean; installed: boolean }> = {
      claude: { available: false, installed: false },
      codex: { available: false, installed: false },
      test: { available: false, installed: false },
      gemini: { available: true, installed: true },
    };
    const provider = aiModelProvider(geminiModelRoleNames.chat);
    expect(provider).toBe("gemini");
    expect(providers[provider].available).toBe(true);
    expect(AI_MODELS.filter((m) => !m.hidden && providers[aiModelProvider(m.id)].installed)
      .map((m) => m.id)).toEqual([geminiModelRoleNames.chat]);
  });

  for (const id of ["unknown-model", "claude-retired", "gemini-retired", "gpt-retired"]) {
    test(`rejects an uncatalogued model: ${id}`, () => {
      throws(() => aiModelProvider(id), { message: `Unknown chat model: ${id}` });
    });
  }
});
