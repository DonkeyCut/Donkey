import { isLocale, type Locale } from "@/i18n/locales";
import { requestedLocale } from "@/cut/lib/defaultNames";
import { prisma } from "@/lib/prisma";

/** The language a cloud write names new content in: the one its request
 * named, else the account's saved language (a headless runner names none),
 * else the default. */
export async function creatorLocaleOf(userId: string, named?: unknown): Promise<Locale> {
  if (isLocale(named)) {
    return named;
  }
  const user = await prisma.user.findUnique({ select: { locale: true }, where: { id: userId } });
  return requestedLocale(user?.locale);
}
