import { isLocale, LOCALE_COOKIE, type Locale } from "@/i18n/locales";
import { negotiateLocale } from "@/i18n/negotiate";

/**
 * The language a request is served in, the same everywhere a request lands:
 * the language a picker saved in the cookie, else the closest match to the
 * browser's Accept-Language. The proxy routes pages on it, so a route handler
 * that reads it answers in the language the page was drawn in.
 */
export function requestLocale(request: Request): Locale {
  const picked = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${LOCALE_COOKIE}=`))
    ?.slice(LOCALE_COOKIE.length + 1);
  if (isLocale(picked)) {
    return picked;
  }
  return negotiateLocale(request.headers.get("accept-language"));
}
