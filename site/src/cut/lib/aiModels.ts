import { geminiModelRoleNames } from "@/lib/inference/gemini-models";

export interface AiModel {
  id: string;
  label: string;
  provider: "claude" | "codex" | "gemini" | "test";
  hidden?: boolean;
}

/** The assistant's model catalog. It lives in the page so a site deploy
 * updates every user's picker immediately; the engine never sees this list —
 * chat passes the chosen id straight to the provider CLI or hosted route, so
 * new models work against older installed engines too.
 * Claude ids follow Claude Code's catalog; GPT ids follow Codex's catalog.
 * Gemini runs through Donkey's hosted inference (sign-in + credits), not a local CLI. */
export const AI_MODELS: AiModel[] = [
  { id: "claude-fable-5-1", label: "Fable 5.1", provider: "claude" },
  { id: "claude-opus-5-5", label: "Opus 5.5", provider: "claude" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", provider: "claude" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", provider: "claude" },
  { id: "gpt-6-astra", label: "GPT-6 Astra", provider: "codex" },
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", provider: "codex" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", provider: "codex" },
  { id: "gpt-6-luna", label: "GPT-6 Luna", provider: "codex" },
  { id: geminiModelRoleNames.chat, label: "Gemini Flash", provider: "gemini" },
  // Hermetic test provider for e2e runs — hidden unless enabled in the UI.
  { id: "cut-test", label: "Test model", provider: "test", hidden: true },
];

/** Ids that left the catalog, each mapped to the current model from the same
 * provider that takes over its role. A saved selection or favorite that names
 * a retired id moves to its replacement on load. */
export const RETIRED_CHAT_MODELS: Record<string, string> = {
  "claude-opus-5": "claude-opus-5-5",
  "claude-sonnet-5": "claude-sonnet-5-5",
  "gpt-5.6-sol": "gpt-6.1-sol",
  "gpt-6-sol": "gpt-6.1-sol",
  "gpt-5.6-luna": "gpt-6-luna",
};

/** The catalog id a saved id runs as today: itself when it is in the catalog,
 * its replacement when it was retired, undefined when it is unknown. */
export function currentChatModel(id: string): string | undefined {
  if (AI_MODELS.some((m) => m.id === id)) return id;
  return RETIRED_CHAT_MODELS[id];
}

export function aiModelProvider(id: string): AiModel["provider"] {
  const model = AI_MODELS.find((m) => m.id === id);
  if (!model) throw new Error(`Unknown chat model: ${id}`);
  return model.provider;
}
