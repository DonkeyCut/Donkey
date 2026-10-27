// The account settings a headless session may change for its user: the
// interface language, which the chat's set_interface_language tool saves
// when no editor page is there to do it.
import { prisma } from "@/lib/prisma";
import { isLocale } from "@/i18n/locales";
import { caught, err } from "./util";

const HTTP_BAD_REQUEST = 400;

export const accountCloud = {
  async setLocale(userId: string, req: Request) {
    try {
      const body = (await req.json().catch(() => null)) as { locale?: unknown } | null;
      const locale = body?.locale;
      if (!isLocale(locale)) {
        return err("A supported locale is required.", HTTP_BAD_REQUEST);
      }
      await prisma.user.update({ where: { id: userId }, data: { locale } });
      return Response.json({ locale });
    } catch (e) {
      return caught(e, "Could not save the language.");
    }
  },
};
