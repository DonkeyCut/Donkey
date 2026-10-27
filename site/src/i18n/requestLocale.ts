import type { NextRequest } from "next/server";

import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, type Locale } from "@/i18n/locales";

/** The reader's locale in a route handler, which has no root params: the
 * cookie the proxy routes on, else English. */
export function requestLocale(request: NextRequest): Locale {
  const picked = request.cookies.get(LOCALE_COOKIE)?.value;
  return isLocale(picked) ? picked : DEFAULT_LOCALE;
}
