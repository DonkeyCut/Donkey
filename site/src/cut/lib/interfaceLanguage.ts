import type { Locale } from "@/i18n/locales";

import { cloudRequest } from "./backend/cloud";
import { chatOwner } from "./chatAssets";

// The interface language as a tool target. In the editor, the chat session
// that runs the turn takes the change: it saves the account's language and
// reloads the page in it once the reply finishes, so the reload never cuts a
// turn short. A session with no editor page (a cloud worker turn, a ChatGPT
// command batch) saves the account's language on the hosted site, and the
// editor opens in it the next time it loads.

const ACCOUNT_LOCALE_PATH = "/api/cut-cloud/account/locale";

/** Where a language change landed, for the tool's result. */
export type LanguageChange = "page" | "account";

const sinks = new Map<string, (locale: Locale) => void>();

/** Register the mounted session's switch for its thread; returns the release. */
export function registerLanguageSink(threadId: string, sink: (locale: Locale) => void): () => void {
  sinks.set(threadId, sink);
  return () => {
    if (sinks.get(threadId) === sink) {
      sinks.delete(threadId);
    }
  };
}

/** Change the interface language for the streaming turn's person. */
export async function changeInterfaceLanguage(locale: Locale): Promise<LanguageChange> {
  // The editor page: its session saves and reloads after the reply.
  const sink = sinks.get(chatOwner() ?? "");
  if (sink) {
    sink(locale);
    return "page";
  }

  // No page: the account keeps the choice for the next load.
  const res = await cloudRequest(ACCOUNT_LOCALE_PATH, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ locale }),
  });
  if (!res.ok) {
    throw new Error(`Could not save the account's language (${res.status}).`);
  }
  return "account";
}
