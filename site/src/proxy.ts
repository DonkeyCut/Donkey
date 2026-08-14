import { NextResponse, type NextRequest } from "next/server";

import { allowedOrigin, corsHeaders, preflightHeaders } from "@/cut/server/cors";
import {
  DONKEYCUT_CANONICAL,
  isDonkeycutHost,
  isLocalHost,
} from "@/cut/lib/hosts";

// Cut (the video editor, publicly "Donkey Cut") lives under /cut in this single
// site app: the marketing landing at /cut and the app under /cut/app. Every
// host gets the same mapping — "/" → landing, "/app/…" → editor app (generic
// "/…" → "/cut/…" rewrite) — with donkeycut.com as the one production host.
// The auth pages (/sign-in, /sign-up), "/install", and the legal pages are
// real root-level routes and pass through the rewrite.
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

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isCutApi(pathname)) return cutApi(req);

  const host = req.headers.get("host");

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
  // The notch prototype is a dev-only page.
  if (isLocalHost(host) && underPath(pathname, "/prototype")) {
    return NextResponse.next();
  }

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
