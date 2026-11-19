// The gallery templates a person starred. Favorites live on the account, so
// a star made in the browser shows on the Mac, in the cloud and in chat.
import { UserError } from "@/cut/lib/userError";
import { getDonkeyAuthContext } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";
import { caught, err } from "./util";

const SIGN_IN = new UserError("template_favorite_sign_in", "Sign in to favorite templates.");
const NOT_FOUND = new UserError("template_missing", "This template isn't available anymore.");
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const PRIVATE_CACHE = "private, no-store";

// The account behind a request: a session, the worker's runner grant, or an
// API key, as template search accepts.
async function callerId(req: Request): Promise<string | null> {
  const caller = await getDonkeyAuthContext(req.headers, { allowRunner: true, allowApiKey: true });
  return caller?.userId ?? null;
}

/** The ids a person starred, newest first. */
export async function favoriteIds(userId: string): Promise<string[]> {
  const rows = await prisma.cutTemplateFavorite.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { templateId: true },
  });
  return rows.map((r) => r.templateId);
}

export const favoritesApi = {
  /** The signed-in person's starred template ids. */
  async list(req: Request) {
    try {
      const userId = await callerId(req);
      if (!userId) {
        return err(SIGN_IN, HTTP_UNAUTHORIZED);
      }
      return Response.json({ ids: await favoriteIds(userId) }, { headers: { "Cache-Control": PRIVATE_CACHE } });
    } catch (e) {
      return caught(e, "Could not read your favorite templates.");
    }
  },

  /** Star a published template; starring it twice keeps one row. */
  async add(id: string, req: Request, published: (id: string) => Promise<boolean>) {
    try {
      const userId = await callerId(req);
      if (!userId) {
        return err(SIGN_IN, HTTP_UNAUTHORIZED);
      }
      if (!(await published(id))) {
        return err(NOT_FOUND, HTTP_NOT_FOUND);
      }
      await prisma.cutTemplateFavorite.upsert({
        where: { userId_templateId: { userId, templateId: id } },
        create: { userId, templateId: id },
        update: {},
      });
      return Response.json({ id, favorite: true });
    } catch (e) {
      return caught(e, "Could not favorite the template.");
    }
  },

  /** Take a template's star off; one never starred is already off. */
  async remove(id: string, req: Request) {
    try {
      const userId = await callerId(req);
      if (!userId) {
        return err(SIGN_IN, HTTP_UNAUTHORIZED);
      }
      await prisma.cutTemplateFavorite.deleteMany({ where: { userId, templateId: id } });
      return Response.json({ id, favorite: false });
    } catch (e) {
      return caught(e, "Could not remove the template from favorites.");
    }
  },
};
