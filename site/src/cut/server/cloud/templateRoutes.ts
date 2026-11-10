// The template gallery's public API, namespaced under /api/templates/*.
// After the template id, paths mirror the engine's /api/cut/* table the way a
// share's do, so the client's template backend is a prefix rewrite and the
// read-only editor opens a template exactly as it opens a share.
import { matchRouteTable, type RouteEntry } from "../http/match";
import { TEMPLATE_POSTER, TEMPLATE_PREVIEW, templatesApi } from "./templates";

type TemplateHandler = (req: Request, params: Record<string, string>) => Promise<Response>;

interface TemplateRoute extends RouteEntry {
  handler: TemplateHandler;
}

const TEMPLATE_ROUTES: TemplateRoute[] = [
  { method: "GET", path: "/api/templates", handler: () => templatesApi.list() },
  { method: "GET", path: "/api/templates/:id", handler: (_r, p) => templatesApi.meta(p.id) },
  { method: "GET", path: "/api/templates/:id/poster", handler: (_r, p) => templatesApi.card(p.id, TEMPLATE_POSTER) },
  { method: "GET", path: "/api/templates/:id/preview", handler: (_r, p) => templatesApi.card(p.id, TEMPLATE_PREVIEW) },
  { method: "POST", path: "/api/templates/:id/copy", handler: (r, p) => templatesApi.copy(p.id, r) },
  { method: "GET", path: "/api/templates/:id/projects/:pid", handler: (r, p) => templatesApi.doc(p.id, p.pid, r) },
  { method: "GET", path: "/api/templates/:id/projects/:pid/media/:file", handler: (_r, p) => templatesApi.media(p.id, p.pid, p.file) },
  { method: "POST", path: "/api/templates/:id/media/presign-get", handler: (r, p) => templatesApi.presignGet(p.id, r) },
];

export async function templatesCatchAll(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  const match = matchRouteTable(TEMPLATE_ROUTES, req.method, pathname);
  if (!match) {
    return new Response("Not found.", { status: 404 });
  }
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
