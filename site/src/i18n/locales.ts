// The languages Donkey Cut ships in. English is the source every other
// catalog is translated from; a locale here has a messages folder beside this
// file, and the build prerenders every page once per locale.

export const LOCALES = ["en", "es", "pt-BR", "fr", "de", "ja", "ko", "zh-CN"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

// The cookie the proxy routes on. Readable by the page, so the language
// pickers can write it and the app can compare it to the account's choice.
export const LOCALE_COOKIE = "NEXT_LOCALE";

export const LOCALE_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 365;

// Each language named in itself, so a reader finds theirs in any UI language.
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  es: "Español",
  "pt-BR": "Português (Brasil)",
  fr: "Français",
  de: "Deutsch",
  ja: "日本語",
  ko: "한국어",
  "zh-CN": "简体中文",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}
