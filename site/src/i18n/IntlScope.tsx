import type { ReactNode } from "react";
import type { AbstractIntlMessages } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";

import { ClientIntl } from "@/i18n/ClientIntl";
import type { Namespace } from "@/i18n/namespaces";

/**
 * Hands the client components under it the namespaces they render. A nested
 * scope replaces the one above it, so each lists everything its subtree needs.
 */
export async function IntlScope({
  namespaces,
  children,
}: {
  namespaces: readonly Namespace[];
  children: ReactNode;
}) {
  const [locale, messages] = await Promise.all([getLocale(), getMessages()]);
  const picked = Object.fromEntries(namespaces.map((namespace) => [namespace, messages[namespace]]));
  return (
    <ClientIntl locale={locale} messages={picked as AbstractIntlMessages}>
      {children}
    </ClientIntl>
  );
}
