import { NextResponse, type NextRequest } from "next/server";

import { allowedOrigin, corsHeaders, preflightHeaders } from "@/cut/server/cors";
import {
  DONKEYCUT_CANONICAL,
  SU_APP_ORIGIN,
  SU_ORIGIN,
  isDonkeycutHost,
  isSuHost,
} from "@/cut/lib/hosts";

// Cut (the video editor, publicly "Donkey Cut") lives under /cut in this single
// site app: the marketing landing at /cut and the app under /cut/app. The
// product host gets that mapping — "/" → landing, "/app/…" → editor app
// (generic "/…" → "/cut/…" rewrite) — with donkeycut.com as the one production
// host. The auth pages (/sign-in, /sign-up), "/install", and the legal pages
// are real root-level routes and pass through the rewrite.
//
// su.donkeycut.com is the second surface this file routes: the super-user
// section under /su, served at bare addresses ("/analytics") on that host
// alone. It shares the deployment and its /api handlers, and it shares the
// session, because auth cookies are scoped to donkeycut.com (src/lib/auth.ts).
// www. 308s to the apex; retired domains redirect to donkeycut.com at the
// edge (Cloudflare) and never reach this app.
//
// This file must live in src/ (next to app/) and use the Next 16 `proxy` name;
// a root-level middleware.ts is not loaded when the app is under src/.

// Cut's server APIs are local-only (see src/cut/server/local-only.ts): the
// hosted deploy serves only Cut's client bundle, and that page drives the
// engine running on the user's own Mac. Two rules follow:
//  - hosted: these API paths 404 before any handler runs, so no Cut server
//    code (disk, ffmpeg, the user's AI CLIs) can execute off-Mac and the
//    unauthenticated routes are unreachable.
//  - local: the page served from the hosted origin calls this engine
//    cross-origin, so grant exactly that origin CORS.
const CUT_API_PREFIX = "/api/cut";
const HOSTED = Boolean(process.env.VERCEL);

const isCutApi = (pathname: string) =>
  pathname === CUT_API_PREFIX || pathname.startsWith(`${CUT_API_PREFIX}/`);

function cutApi(req: NextRequest): NextResponse {
  if (HOSTED) return new NextResponse(null, { status: 404 });

  // Same CORS policy as the packaged engine (src/cut/server/cors.ts): grant the
  // hosted Cut origin, pass everything else through as same-origin dev traffic.
  const cors = allowedOrigin(req.headers.get("origin") ?? "");
  if (!cors) return NextResponse.next();

  if (req.method === "OPTIONS") {
    return new NextResponse(null, {
      status: 204,
      headers: preflightHeaders(cors, req.headers.get("access-control-request-headers")),
    });
  }
  const res = NextResponse.next();
  for (const [k, v] of Object.entries(corsHeaders(cors))) res.headers.set(k, v);
  return res;
}

// Root-level routes the generic "/…" → "/cut/…" rewrite must not capture:
// auth pages, the Mac download, and the legal pages. "/app/settings" is not
// among them: Cut ships its own billing and usage pages under
// /cut/app/settings, which the generic rewrite serves at /app/settings.
const PASSTHROUGH = [
  "/install",
  "/privacy",
  "/terms",
  "/sign-in",
  "/sign-up",
  // Email-footer unsubscribe page.
  "/unsubscribe",
];

// Whole-segment prefix match, so "/cut" covers "/cut/…" but not "/cut-app".
const underPath = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

const passesThrough = (pathname: string) =>
  PASSTHROUGH.some((p) => underPath(pathname, p));

// The super-user host serves one section and nothing else: /su/… for pages,
// the shared /api handlers for their data.
//
// The role gate lives here, ahead of the route. A page's document preloads
// the client code of every segment on its path whether or not that segment
// renders, so a gate inside the route tree would still hand the section's
// bundle — the charts, the tables, the shell — to whoever asked for the
// address. Here the proxy asks the account route who is calling (the session
// cookie is scoped to the apex, so it reads the same on this host) and only a
// super user reaches a page; everyone else gets a redirect and no document.
// Sign-in lives on the app's host, so a signed-out visitor leaves for it with
// this address as the post-auth callback, and a signed-in visitor without the
// role is sent to the app. The routes the pages call are withSuperUser and
// enforce the role again on every request.
//
// Nothing here belongs in a search index, so every page response carries the
// header that says so.
const SU_ROOT = "/su";

// The gate's answer is held per cookie for a short while. A page visit is
// several requests — the document, then the router's prefetch of every page
// on the rail, each a handful of segment fetches — and every one of them
// passed through the gate, so a visit cost dozens of session lookups and
// each prefetch waited on one. The hold is short because the answer decides
// who is served the section's code; the data routes check the role on every
// request regardless.
const GATE_HOLD_MS = 30_000;
const GATE_HOLD_MAX = 256;
const gateHeld = new Map<string, { superUser: boolean; until: number }>();

async function gateAnswer(cookie: string): Promise<{ status: number; superUser: boolean }> {
  const held = gateHeld.get(cookie);
  if (held && held.until > Date.now()) return { status: 200, superUser: held.superUser };
  const account = await fetch(`${SU_APP_ORIGIN}/api/account/me`, {
    cache: "no-store",
    headers: { cookie },
  });
  if (!account.ok) return { status: account.status, superUser: false };
  const { superUser } = (await account.json()) as { superUser: boolean };
  if (cookie) {
    if (gateHeld.size >= GATE_HOLD_MAX) gateHeld.delete(gateHeld.keys().next().value!);
    gateHeld.set(cookie, { superUser: superUser === true, until: Date.now() + GATE_HOLD_MS });
  }
  return { status: 200, superUser: superUser === true };
}

async function suHost(req: NextRequest, pathname: string): Promise<NextResponse> {
  if (underPath(pathname, "/api")) return NextResponse.next();

  const account = await gateAnswer(req.headers.get("cookie") ?? "");
  if (account.status === 401) {
    // The callback has to carry the exact origin sign-in trusts (src/lib/auth.ts),
    // so hosted names it from the constant; dev's su.localhost is plain http on
    // whatever host the browser asked for.
    const origin = HOSTED ? SU_ORIGIN : `http://${req.headers.get("host")}`;
    const here = `${origin}${pathname}${req.nextUrl.search}`;
    return NextResponse.redirect(
      `${SU_APP_ORIGIN}/sign-in?callbackURL=${encodeURIComponent(here)}`,
    );
  }
  if (account.status !== 200) {
    return new NextResponse("The super-user gate is unavailable.", { status: 503 });
  }
  if (!account.superUser) return NextResponse.redirect(`${SU_APP_ORIGIN}/app`);

  const url = req.nextUrl.clone();
  url.pathname = `${SU_ROOT}${pathname === "/" ? "" : pathname}`;
  const res = NextResponse.rewrite(url);
  res.headers.set("X-Robots-Tag", "noindex, nofollow");
  return res;
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isCutApi(pathname)) return cutApi(req);

  const host = req.headers.get("host");

  if (isSuHost(host)) return suHost(req, pathname);

  // Aliases (www.) canonicalize to the apex.
  if (isDonkeycutHost(host) && host?.split(":")[0] !== "donkeycut.com") {
    const url = req.nextUrl.clone();
    return NextResponse.redirect(
      `${DONKEYCUT_CANONICAL}${pathname}${url.search}`,
      308,
    );
  }

  // Legacy direct /cut/… links canonicalize to the rewritten address:
  // /cut/app/… → /app/….
  if (underPath(pathname, "/cut")) {
    const url = req.nextUrl.clone();
    url.pathname = pathname.slice("/cut".length) || "/";
    return NextResponse.redirect(url, 308);
  }

  if (underPath(pathname, "/api")) return NextResponse.next();
  if (passesThrough(pathname)) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname =
    pathname === "/sitemap.xml"
      ? "/cut/sitemap.xml"
      : `/cut${pathname === "/" ? "" : pathname}`;
  return NextResponse.rewrite(url);
}

export const config = {
  // Page routes (skip Next internals and files with an extension) plus every
  // Cut API path — including media/export files with extensions — so the
  // hosted 404 and local CORS above cover all of them. "/sitemap.xml" is
  // matched explicitly so donkeycut.com can serve its own sitemap.
  matcher: [
    "/((?!_next/|.*\\..*).*)",
    "/api/cut/:path*",
    "/sitemap.xml",
  ],
};
