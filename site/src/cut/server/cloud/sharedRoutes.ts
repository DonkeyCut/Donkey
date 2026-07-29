// The public shared-viewer API surface, namespaced under /api/cut-shared/*.
// Paths mirror the engine table after the token segment so the client's shared
// driver is a pure prefix rewrite of /api/cut/*. There is no auth wrapper:
// access is decided per request by the share row (public, or a signed-in
// invitee) inside sharedView's resolver.
import { matchRouteTable, type RouteEntry } from "../http/match";
import { copyJobs } from "./copyQueue";
import { sharedView } from "./sharedView";

type SharedHandler = (req: Request, params: Record<string, string>) => Promise<Response>;

interface SharedRoute extends RouteEntry {
  handler: SharedHandler;
}

const CUT_SHARED_ROUTES: SharedRoute[] = [
  { method: "GET", path: "/api/cut-shared/:token", handler: (r, p) => sharedView.meta(p.token, r) },
  { method: "GET", path: "/api/cut-shared/:token/projects/:id", handler: (r, p) => sharedView.doc(p.token, p.id, r) },
  { method: "GET", path: "/api/cut-shared/:token/projects/:id/media/:file", handler: (r, p) => sharedView.serveMedia(p.token, p.id, p.file, r) },
  { method: "POST", path: "/api/cut-shared/:token/media/presign-get", handler: (r, p) => sharedView.presignGetBatch(p.token, r) },
  { method: "GET", path: "/api/cut-shared/:token/projects/:id/chats", handler: (r, p) => sharedView.chats(p.token, p.id, r) },
  { method: "GET", path: "/api/cut-shared/:token/projects/:id/preview", handler: (r, p) => sharedView.preview(p.token, p.id, r) },
  { method: "GET", path: "/api/cut-shared/:token/projects/:id/stream", handler: (r, p) => sharedView.stream(p.token, p.id, r) },
  { method: "POST", path: "/api/cut-shared/:token/copy", handler: (r, p) => copyJobs.request(p.token, r) },
  { method: "GET", path: "/api/cut-shared/:token/copy/:jobId", handler: (r, p) => copyJobs.status(p.token, p.jobId, r) },
];

export async function cutSharedCatchAll(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  const match = matchRouteTable(CUT_SHARED_ROUTES, req.method, pathname);
  if (!match) return new Response("Not found.", { status: 404 });
  if ("methodNotAllowed" in match) {
    return new Response("Method not allowed.", {
      status: 405,
      headers: { Allow: match.methodNotAllowed.join(", ") },
    });
  }
  const res = await match.route.handler(req, match.params);
  if (match.head && res.body) {
    void res.body.cancel();
    return new Response(null, { status: res.status, headers: res.headers });
  }
  return res;
}
