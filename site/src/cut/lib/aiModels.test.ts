import { describe, expect, test } from "bun:test";
import { throws } from "node:assert/strict";
import {
  AI_MODELS,
  RETIRED_CHAT_MODELS,
  aiModelProvider,
  currentChatModel,
  type AiModel,
} from "@/cut/lib/aiModels";
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

describe("retired chat models", () => {
  const providerOf = (id: string) => {
    const family = id.startsWith("claude") ? "claude" : id.startsWith("gpt") ? "codex" : "gemini";
    return family;
  };

  test("every replacement is in the catalog, from the retired id's provider", () => {
    for (const [retired, replacement] of Object.entries(RETIRED_CHAT_MODELS)) {
      expect(AI_MODELS.some((m) => m.id === replacement)).toBe(true);
      expect(aiModelProvider(replacement)).toBe(providerOf(retired));
    }
  });

  test("no retired id is still in the catalog", () => {
    for (const retired of Object.keys(RETIRED_CHAT_MODELS)) {
      expect(AI_MODELS.some((m) => m.id === retired)).toBe(false);
    }
  });

  test("currentChatModel maps retired ids and passes current ids through", () => {
    for (const [retired, replacement] of Object.entries(RETIRED_CHAT_MODELS)) {
      expect(currentChatModel(retired)).toBe(replacement);
    }
    for (const model of AI_MODELS) {
      expect(currentChatModel(model.id)).toBe(model.id);
    }
    expect(currentChatModel("unknown-model")).toBeUndefined();
  });
});
