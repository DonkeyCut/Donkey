"use client";

import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE_S, isLocale, type Locale } from "@/i18n/locales";

/** The locale this browser chose, when it has chosen one. */
export function readLocaleCookie(): Locale | null {
  const entry = document.cookie.split("; ").find((part) => part.startsWith(`${LOCALE_COOKIE}=`));
  const value = entry?.slice(LOCALE_COOKIE.length + 1);
  return isLocale(value) ? value : null;
}

/**
 * Switches this browser to a locale. Every URL serves every language, and the
 * router caches pages by URL, so the page reloads to draw in the new one.
 * A browser that refuses the cookie (blocked cookies, a cross-site frame)
 * would serve the old language again, so it stays put and this answers false.
 */
export function switchLocale(locale: Locale): boolean {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE_S}; SameSite=Lax${secure}`;
  if (readLocaleCookie() !== locale) {
    return false;
  }
  location.reload();
  return true;
}
