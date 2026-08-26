import { toNextJsHandler } from "better-auth/next-js";

import { AUTH_COOKIE_DOMAIN } from "@/cut/lib/hosts";
import { auth } from "@/lib/auth";

// better-auth's handler serves GET/POST for the whole /api/auth/* surface
// (sign-in, callback, session, sign-out).
const handler = toNextJsHandler(auth);

const DOMAIN_ATTRIBUTE = `domain=${AUTH_COOKIE_DOMAIN}`;

/** The names this response scopes to the registrable host. */
function scopedCookieNames(headers: Headers): Set<string> {
  const names = new Set<string>();
  for (const cookie of headers.getSetCookie()) {
    const [pair, ...attributes] = cookie.split(";");
    const name = pair?.split("=")[0]?.trim();
    if (!name) continue;
    const scoped = attributes.some(
      (a) => a.trim().toLowerCase() === DOMAIN_ATTRIBUTE,
    );
    if (scoped) names.add(name);
  }
  return names;
}

// Auth cookies carry Domain=donkeycut.com so the session reaches the site's
// subdomains. Browsers that signed in before that still hold a host-only
// cookie under the same name and send both, and better-auth expires only the
// one it set: a sign-out would clear the scoped cookie and leave the older one
// standing, whose session row is still live, signing the visitor straight back
// in. So every response that writes a scoped cookie clears its host-only twin
// in the same response, which also settles which of the two a request carries.
// Rebuilt rather than mutated because a redirect response can arrive frozen.
function clearHostOnlyTwins(response: Response): Response {
  const names = scopedCookieNames(response.headers);
  if (names.size === 0) return response;

  const headers = new Headers(response.headers);
  for (const name of names) {
    headers.append(
      "Set-Cookie",
      `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    );
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export const GET = async (request: Request) =>
  clearHostOnlyTwins(await handler.GET(request));

export const POST = async (request: Request) =>
  clearHostOnlyTwins(await handler.POST(request));
