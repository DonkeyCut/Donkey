import { geminiModels } from "@/lib/inference/gemini-models";

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
 * Claude ids verified against the local CLI; GPT ids are Codex's naming.
 * Gemini runs through Donkey's hosted inference (sign-in + credits), not a local CLI. */
export const AI_MODELS: AiModel[] = [
  { id: "claude-fable-5", label: "Fable 5", provider: "claude" },
  { id: "claude-opus-5", label: "Opus 5", provider: "claude" },
  { id: "claude-sonnet-5", label: "Sonnet 5", provider: "claude" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", provider: "claude" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", provider: "codex" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "codex" },
  { id: "gpt-5.5", label: "GPT-5.5", provider: "codex" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", provider: "codex" },
  { id: geminiModels.flash, label: "Gemini Flash", provider: "gemini" },
  // Hermetic test provider for e2e runs — hidden unless enabled in the UI.
  { id: "cut-test", label: "Test model", provider: "test", hidden: true },
];
