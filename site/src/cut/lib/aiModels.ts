import { RETIRED_GEMINI_ROLES, geminiChatPicks, geminiModelRoleNames } from "@/lib/inference/gemini-models";

export interface AiModel {
  id: string;
  label: string;
  provider: "claude" | "codex" | "gemini" | "test";
  hidden?: boolean;
  /** The newer model that takes this one's place on accounts that run it.
   * The older one stays for accounts the provider has not moved yet. */
  supersededBy?: string;
}

/** The assistant's model catalog. It lives in the page so a site deploy
 * updates every user's picker immediately; the engine never sees this list —
 * chat passes the chosen id straight to the provider CLI or hosted route, so
 * new models work against older installed engines too.
 * Claude ids follow Claude Code's catalog; GPT ids follow Codex's catalog.
 * Gemini runs through Donkey's hosted inference (sign-in + credits), not a local CLI. */
export const AI_MODELS: AiModel[] = [
  { id: "claude-fable-5-2", label: "Fable 5.2", provider: "claude" },
  { id: "claude-opus-5-5", label: "Opus 5.5", provider: "claude" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", provider: "claude" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", provider: "claude" },
  { id: "gpt-6-astra", label: "GPT-6 Astra", provider: "codex" },
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", provider: "codex" },
  { id: "gpt-6.1-terra", label: "GPT-6.1 Terra", provider: "codex" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", provider: "codex", supersededBy: "gpt-6.1-terra" },
  { id: "gpt-6-luna", label: "GPT-6 Luna", provider: "codex" },
  ...geminiChatPicks.map((pick): AiModel => ({ id: pick.role, label: pick.label, provider: "gemini" })),
  // Hermetic test provider for e2e runs — hidden unless enabled in the UI.
  { id: "cut-test", label: "Test model", provider: "test", hidden: true },
];

/** A fresh user's model: Gemini runs on their Donkey account, so it needs no
 * local CLI, and the chat eval picks which Gemini model. A pick persists, so
 * this is first-run only. */
export const DEFAULT_CHAT_MODEL: string = geminiModelRoleNames.chat;

/** Ids that left the catalog, each mapped to the current model from the same
 * provider that takes over its role. A saved selection or favorite that names
 * a retired id moves to its replacement on load. */
export const RETIRED_CHAT_MODELS: Record<string, string> = {
  "claude-fable-5-1": "claude-fable-5-2",
  "claude-opus-5": "claude-opus-5-5",
  "claude-sonnet-5": "claude-sonnet-5-5",
  "claude-haiku-4-5-20251001": "claude-haiku-5-5",
  "gpt-5.6-sol": "gpt-6.1-sol",
  "gpt-6-sol": "gpt-6.1-sol",
  "gpt-5.6-luna": "gpt-6-luna",
  ...RETIRED_GEMINI_ROLES,
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

/** What the engine reports for one provider. `models` lists the ids the
 * signed-in account can run, when the provider's CLI can say: a ChatGPT
 * login gets a per-account Codex catalog, and a model missing from it fails
 * every turn with "not supported when using Codex with a ChatGPT account". */
export interface ChatProvider {
  available: boolean;
  note: string;
  installed?: boolean;
  models?: string[];
}

export type ChatProviders = Partial<Record<AiModel["provider"], ChatProvider>>;

/** Whether the account behind the model's provider runs it; true when the
 * engine names no account list. */
export function accountRuns(id: string, providers: ChatProviders): boolean {
  const models = providers[aiModelProvider(id)]?.models;
  if (!models) return true;
  return models.includes(id);
}

/** Whether the picker lists the model: the account runs it and does not run
 * the successor that takes its place. */
export function pickerOffers(model: AiModel, providers: ChatProviders): boolean {
  if (!accountRuns(model.id, providers)) return false;
  return !model.supersededBy || !accountRuns(model.supersededBy, providers);
}

/** The model a pick runs as: itself when its provider is installed and the
 * account runs it, else the first model of the same provider the account
 * runs, else the first model of any installed provider (the default pick
 * when that provider is the default's).
 * Example: "gpt-6.1-sol" on a ChatGPT account without it → "gpt-6-luna". */
export function runnableChatModel(id: string, providers: ChatProviders): string | undefined {
  const runs = (m: AiModel) =>
    !m.hidden && providers[m.provider]?.installed !== false && pickerOffers(m, providers);
  const picked = AI_MODELS.find((m) => m.id === id);
  if (picked && providers[picked.provider]?.installed !== false && pickerOffers(picked, providers)) {
    return id;
  }

  // A superseded pick moves to its successor where the account runs it.
  const successor = AI_MODELS.find((m) => m.id === picked?.supersededBy);
  if (successor && runs(successor)) return successor.id;

  // Same provider first, so a GPT pick stays on GPT.
  const sibling = AI_MODELS.find((m) => m.provider === picked?.provider && runs(m));
  if (sibling) return sibling.id;

  // Then the first installed provider; landing on the default's provider
  // lands on the default itself.
  const first = AI_MODELS.find(runs);
  const fallback = AI_MODELS.find((m) => m.id === DEFAULT_CHAT_MODEL);
  if (first && fallback && first.provider === fallback.provider && runs(fallback)) return fallback.id;
  return first?.id;
}
