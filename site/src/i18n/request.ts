import { notFound } from "next/navigation";
import { locale as rootLocale } from "next/root-params";
import { getRequestConfig } from "next-intl/server";

import { isLocale } from "@/i18n/locales";
import { loadMessages } from "@/i18n/messages";
import { NAMESPACES } from "@/i18n/namespaces";

// next-intl's server config. The locale is the root [locale] segment the
// proxy rewrote the request into, so it is part of every page's static
// params and every server component reads it without a prop.
export default getRequestConfig(async () => {
  const locale = await rootLocale();
  if (!isLocale(locale)) {
    notFound();
  }
  return { locale, messages: await loadMessages(locale, NAMESPACES) };
});
