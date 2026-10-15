import { describe, expect, test } from "bun:test";
import { throws } from "node:assert/strict";
import {
  AI_MODELS,
  RETIRED_CHAT_MODELS,
  accountRuns,
  aiModelProvider,
  currentChatModel,
  runnableChatModel,
  type AiModel,
  type ChatProviders,
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

describe("models the signed-in account runs", () => {
  // The catalog a ChatGPT login served Codex on 2026-10-14: GPT-6.1 Sol and
  // GPT-6 Astra are in the CLI's bundled list but not yet on this account.
  const account = ["gpt-6-luna", "gpt-reserve", "gpt-5.6-terra", "gpt-5.6-luna"];
  const providers: ChatProviders = {
    claude: { available: true, note: "", installed: true },
    codex: { available: true, note: "", installed: true, models: account },
    gemini: { available: true, note: "", installed: true },
  };

  test("a GPT pick the ChatGPT account lacks moves to the first GPT model it runs", () => {
    expect(runnableChatModel("gpt-6.1-sol", providers)).toBe("gpt-5.6-terra");
    expect(runnableChatModel("gpt-6-astra", providers)).toBe("gpt-5.6-terra");
  });

  test("a pick the account runs stays", () => {
    expect(runnableChatModel("gpt-6-luna", providers)).toBe("gpt-6-luna");
    expect(runnableChatModel("claude-opus-5-5", providers)).toBe("claude-opus-5-5");
  });

  test("the picker offers only the GPT models the account runs", () => {
    const offered = AI_MODELS.filter((m) => accountRuns(m.id, providers)).map((m) => m.id);
    expect(offered).not.toContain("gpt-6.1-sol");
    expect(offered).not.toContain("gpt-6-astra");
    expect(offered).toContain("gpt-5.6-terra");
    expect(offered).toContain("claude-opus-5-5");
  });

  test("an engine that names no account models leaves every model runnable", () => {
    const unlisted: ChatProviders = { ...providers, codex: { available: true, note: "", installed: true } };
    expect(runnableChatModel("gpt-6.1-sol", unlisted)).toBe("gpt-6.1-sol");
  });

  test("a pick whose provider is not installed moves to the first installed one", () => {
    const off = { available: false, note: "", installed: false };
    const geminiOnly: ChatProviders = { claude: off, codex: off, gemini: providers.gemini };
    expect(runnableChatModel("gpt-6.1-sol", geminiOnly)).toBe(geminiModelRoleNames.chat);
  });
});
