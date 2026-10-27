import { createTranslator } from "use-intl/core";

import type { Locale } from "@/i18n/locales";
import { loadMessages } from "@/i18n/messages";
import type { Messages, Namespace } from "@/i18n/namespaces";

/**
 * A translator for code outside React: the Bun engine, the worker, and
 * library code that names what it creates ("Untitled", "Your text") in the
 * language of the person it creates it for.
 */
export async function translatorFor<N extends Namespace>(locale: Locale, namespace: N) {
  const messages = (await loadMessages(locale, [namespace])) as Messages;
  return createTranslator({ locale, messages, namespace });
}
