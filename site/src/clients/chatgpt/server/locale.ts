import { isLocale, type Locale } from "@/i18n/locales";
import { negotiateLocale } from "@/i18n/negotiate";
import { prisma } from "@/lib/prisma";

// ChatGPT names the person's language in a request's _meta; older clients
// use the second key.
const META_LOCALE_KEYS = ["openai/locale", "webplus/i18n"] as const;

/**
 * The language of the status lines ChatGPT shows under a tool call. ChatGPT
 * sends its locale on initialize and tool calls; a tools/list request, which
 * carries the descriptors, may come without it, so the account's saved
 * language answers there, then the request's Accept-Language.
 */
export async function mcpLocale(request: Request, userId: string): Promise<Locale> {
  const tag = await metaLocale(request);
  if (tag) {
    return negotiateLocale(tag);
  }

  const user = await prisma.user.findUnique({ select: { locale: true }, where: { id: userId } });
  if (isLocale(user?.locale)) {
    return user.locale;
  }
  return negotiateLocale(request.headers.get("accept-language"));
}

/** The first locale tag in a JSON-RPC message's (or batch's) params._meta. */
async function metaLocale(request: Request): Promise<string | null> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return null;
  }

  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return null;
  }
  for (const message of Array.isArray(body) ? body : [body]) {
    const meta = (message as { params?: { _meta?: Record<string, unknown> } } | null)?.params?._meta;
    for (const key of META_LOCALE_KEYS) {
      const tag = meta?.[key];
      if (typeof tag === "string" && tag) {
        return tag;
      }
    }
  }
  return null;
}

/** Text a page interpolates into its HTML. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]!);
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
