// The phone's half of upload from phone, namespaced under /api/cut-phone/*.
// There is no auth wrapper: the phone is not signed in. The code in the QR
// opens a drop and the send pass it buys authorizes every file after that,
// both checked per request inside phoneDrops. Each address is rate limited.
import { checkInMemoryRateLimit, rateLimitResponse } from "@/lib/inference/rate-limit";
import { clientIp } from "@/lib/client-ip";

import { matchRouteTable, type RouteEntry } from "../http/match";
import { phoneDropsPublic } from "./phoneDrops";

type PhoneHandler = (req: Request, params: Record<string, string>) => Promise<Response>;

interface PhoneRoute extends RouteEntry {
  handler: PhoneHandler;
}

const CUT_PHONE_ROUTES: PhoneRoute[] = [
  { method: "POST", path: "/api/cut-phone/open", handler: (r) => phoneDropsPublic.open(r) },
  { method: "POST", path: "/api/cut-phone/files", handler: (r) => phoneDropsPublic.start(r) },
  { method: "POST", path: "/api/cut-phone/files/:id/parts", handler: (r, p) => phoneDropsPublic.parts(r, p.id) },
  { method: "PUT", path: "/api/cut-phone/files/:id/thumb", handler: (r, p) => phoneDropsPublic.thumb(r, p.id) },
  { method: "POST", path: "/api/cut-phone/files/:id/complete", handler: (r, p) => phoneDropsPublic.complete(r, p.id) },
  { method: "POST", path: "/api/cut-phone/files/:id/abort", handler: (r, p) => phoneDropsPublic.abort(r, p.id) },
];

/** Requests one address may make a minute. A phone asks for one part URL per
 * 8 MiB it sends, a few files at a time, so a fast connection stays far under
 * this; a script guessing codes does not. */
const REQUESTS_PER_MINUTE = 600;
const MINUTE_MS = 60_000;

export async function cutPhoneCatchAll(req: Request): Promise<Response> {
  const limit = checkInMemoryRateLimit({
    key: `cut-phone:${clientIp(req.headers) ?? "unknown"}`,
    limit: REQUESTS_PER_MINUTE,
    windowMs: MINUTE_MS,
  });
  if (!limit.ok) {
    return rateLimitResponse(limit.retryAfterSeconds);
  }

  const { pathname } = new URL(req.url);
  const match = matchRouteTable(CUT_PHONE_ROUTES, req.method, pathname);
  if (!match) {
    return new Response("Not found.", { status: 404 });
  }
  if ("methodNotAllowed" in match) {
    return new Response("Method not allowed.", {
      status: 405,
      headers: { Allow: match.methodNotAllowed.join(", ") },
    });
  }
  return match.route.handler(req, match.params);
}
