import { NextResponse, type NextRequest } from "next/server";

import { allowedOrigin, corsHeaders, preflightHeaders } from "@/cut/server/cors";
import {
  DONKEYCUT_CANONICAL,
  isDonkeycutHost,
  isLocalHost,
} from "@/cut/lib/hosts";

// Cut (the video editor, publicly "Donkey Cut") lives under /cut in this single
// site app: the marketing landing at /cut and the app under /cut/app. The proxy
// maps its production host onto that tree while the apex host keeps serving
// Donkey:
//
//   donkeycut.com       "/" → landing, "/app/…" → editor app (generic
//                       "/…" → "/cut/…" rewrite). The auth pages (/sign-in,
//                       /sign-up), "/install", and the legal pages
//                       pass through so the shared apex routes serve them
//                       same-host. www. 308s to the apex.
//
// Old cut.donkeyuse.com links are redirected to donkeycut.com at the edge
// (Cloudflare) and never reach this app.
//
// Local dev (localhost) mirrors donkeycut.com — Cut is the default product, so
// "/" is the Cut landing and "/app/…" the editor — while Donkey Use stays
// reachable under "/use/…" (stripped to the apex routes). The session cookie
// stays same-origin because everything is served from the one dev origin.
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

// Paths served by shared apex routes that must not be captured by the generic
// "/…" → "/cut/…" rewrite on donkeycut.com. donkeycut.com owns auth directly,
// so the sign-in/sign-up pages and the Mac-app handoff serve same-host here;
// "/install" carries the Mac download and the legal pages are shared verbatim.
// "/app/settings" is not among them: Cut ships its own billing and usage pages
// under /cut/app/settings, which the generic rewrite serves at /app/settings on
// this host.
const DONKEYCUT_PASSTHROUGH = [
  "/install",
  "/privacy",
  "/terms",
  "/sign-in",
  "/sign-up",
];

// Local dev mirrors donkeycut.com (Cut at "/", the editor at "/app/…"). It adds
// the notch prototype, which only exists on the apex and is exercised from
// localhost during development.
const LOCAL_PASSTHROUGH = [...DONKEYCUT_PASSTHROUGH, "/prototype"];

// Whole-segment prefix match, so "/cut" covers "/cut/…" but not "/cut-app".
const underPath = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

const passesThrough = (pathname: string) =>
  DONKEYCUT_PASSTHROUGH.some((p) => underPath(pathname, p));

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isCutApi(pathname)) return cutApi(req);

  const host = req.headers.get("host");

  // Local dev serves Donkey Cut by default, like donkeycut.com; Donkey Use
  // stays reachable under /use ("/use/…" → apex "/…").
  if (isLocalHost(host)) {
    if (underPath(pathname, "/use")) {
      const url = req.nextUrl.clone();
      url.pathname = pathname === "/use" ? "/" : pathname.slice("/use".length);
      return NextResponse.rewrite(url);
    }
    if (underPath(pathname, "/cut") || underPath(pathname, "/api")) {
      return NextResponse.next();
    }
    if (LOCAL_PASSTHROUGH.some((p) => underPath(pathname, p))) {
      return NextResponse.next();
    }
    const url = req.nextUrl.clone();
    url.pathname = `/cut${pathname === "/" ? "" : pathname}`;
    return NextResponse.rewrite(url);
  }

  if (isDonkeycutHost(host)) {
    if (host?.split(":")[0] !== "donkeycut.com") {
      const url = req.nextUrl.clone();
      return NextResponse.redirect(
        `${DONKEYCUT_CANONICAL}${pathname}${url.search}`,
        308,
      );
    }
    if (underPath(pathname, "/cut") || underPath(pathname, "/api")) {
      return NextResponse.next();
    }
    if (passesThrough(pathname)) return NextResponse.next();
    const url = req.nextUrl.clone();
    url.pathname =
      pathname === "/sitemap.xml"
        ? "/cut/sitemap.xml"
        : `/cut${pathname === "/" ? "" : pathname}`;
    return NextResponse.rewrite(url);
  }

  return NextResponse.next();
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
