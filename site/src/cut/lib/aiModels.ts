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
  { id: "claude-opus-5", label: "Opus 5", provider: "claude" },
  { id: "claude-sonnet-5", label: "Sonnet 5", provider: "claude" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", provider: "claude" },
  { id: "gpt-6-astra", label: "GPT-6 Astra", provider: "codex" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", provider: "codex" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", provider: "codex" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "codex" },
  { id: geminiModelRoleNames.chat, label: "Gemini Flash", provider: "gemini" },
  // Hermetic test provider for e2e runs — hidden unless enabled in the UI.
  { id: "cut-test", label: "Test model", provider: "test", hidden: true },
];

export function aiModelProvider(id: string): AiModel["provider"] {
  const model = AI_MODELS.find((m) => m.id === id);
  if (!model) throw new Error(`Unknown chat model: ${id}`);
  return model.provider;
}
