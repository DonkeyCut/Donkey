import { match } from "@formatjs/intl-localematcher";
import Negotiator from "negotiator";

import { DEFAULT_LOCALE, LOCALES, type Locale } from "@/i18n/locales";

/**
 * The supported locale closest to a browser's Accept-Language header, for a
 * visitor with no saved choice. "pt-PT,pt;q=0.9" lands on pt-BR and "zh" on
 * zh-CN; no header (a crawler) or no match is English.
 */
export function negotiateLocale(acceptLanguage: string | null): Locale {
  if (!acceptLanguage) {
    return DEFAULT_LOCALE;
  }

  const languages = new Negotiator({ headers: { "accept-language": acceptLanguage } }).languages();
  const valid = languages.filter((tag) => {
    try {
      return Intl.getCanonicalLocales(tag).length > 0;
    } catch {
      return false;
    }
  });
  if (valid.length === 0) {
    return DEFAULT_LOCALE;
  }
  return match(valid, LOCALES, DEFAULT_LOCALE) as Locale;
}
