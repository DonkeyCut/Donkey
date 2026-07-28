import { adoptLegacyData, isValidCutUser, runWithCutUser } from "../userScope";
import { matchRouteTable } from "./match";
import { aiApi } from "./ai";
import { engineApi } from "./engine";
import { exportApi } from "./export";
import { libraryApi } from "./library";
import { micApi } from "./mic";
import { projectsApi } from "./projects";
import { sttApi } from "./stt";

type TableHandler = (req: Request, params: Record<string, string>) => Response | Promise<Response>;

interface CutRoute {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string; // ":name" segments bind params
  handler: TableHandler;
  /** Health is the one route outside a user scope: probes and the app's
   * supervisor hit it with no session in hand. */
  scoped?: false;
}

/**
 * The whole Cut API surface in one table, namespaced under /api/cut/* to keep it
 * clear of Donkey's own APIs. Both mounts dispatch through it — the Next
 * catch-all route and the packaged engine — so the two surfaces cannot drift.
 */
export const CUT_ROUTES: CutRoute[] = [
  { method: "GET", path: "/api/cut/engine/health", handler: () => engineApi.health(), scoped: false },

  { method: "GET", path: "/api/cut/projects", handler: () => projectsApi.list() },
  { method: "POST", path: "/api/cut/projects", handler: (req) => projectsApi.create(req) },
  { method: "GET", path: "/api/cut/projects/folders", handler: () => projectsApi.folders() },
  { method: "POST", path: "/api/cut/projects/folders", handler: (req) => projectsApi.createFolder(req) },
  { method: "PUT", path: "/api/cut/projects/folders/:id", handler: (req, p) => projectsApi.renameFolder(req, { id: p.id }) },
  { method: "DELETE", path: "/api/cut/projects/folders/:id", handler: (req, p) => projectsApi.deleteFolder(req, { id: p.id }) },
  { method: "POST", path: "/api/cut/projects/:id/move", handler: (req, p) => projectsApi.move(req, { id: p.id }) },
  { method: "GET", path: "/api/cut/projects/:id", handler: (req, p) => projectsApi.get(req, { id: p.id }) },
  { method: "PUT", path: "/api/cut/projects/:id", handler: (req, p) => projectsApi.put(req, { id: p.id }) },
  { method: "DELETE", path: "/api/cut/projects/:id", handler: (req, p) => projectsApi.remove(req, { id: p.id }) },
  { method: "POST", path: "/api/cut/projects/:id/media", handler: (req, p) => projectsApi.uploadMedia(req, { id: p.id }) },
  { method: "POST", path: "/api/cut/projects/:id/import-url", handler: (req, p) => projectsApi.importUrl(req, { id: p.id }) },
  { method: "GET", path: "/api/cut/projects/:id/media/:file", handler: (req, p) => projectsApi.serveMedia(req, { id: p.id, file: p.file }) },
  { method: "DELETE", path: "/api/cut/projects/:id/media/:file", handler: (req, p) => projectsApi.removeMedia(req, { id: p.id, file: p.file }) },
  { method: "POST", path: "/api/cut/projects/:id/media/:file/reveal", handler: (req, p) => projectsApi.revealMedia(req, { id: p.id, file: p.file }) },
  { method: "GET", path: "/api/cut/projects/:id/exports", handler: (req, p) => projectsApi.listExports(req, { id: p.id }) },
  { method: "GET", path: "/api/cut/projects/:id/exports/:file", handler: (req, p) => projectsApi.serveExport(req, { id: p.id, file: p.file }) },
  { method: "DELETE", path: "/api/cut/projects/:id/exports/:file", handler: (req, p) => projectsApi.removeExport(req, { id: p.id, file: p.file }) },
  { method: "POST", path: "/api/cut/projects/:id/exports/:file/reveal", handler: (req, p) => projectsApi.revealExport(req, { id: p.id, file: p.file }) },
  { method: "POST", path: "/api/cut/projects/:id/transcribe", handler: (req, p) => projectsApi.transcribeStart(req, { id: p.id }) },
  { method: "GET", path: "/api/cut/projects/:id/transcribe", handler: (req, p) => projectsApi.transcribePoll(req, { id: p.id }) },
  { method: "POST", path: "/api/cut/projects/:id/image", handler: (req, p) => projectsApi.importImage(req, { id: p.id }) },
  { method: "POST", path: "/api/cut/projects/:id/freeze", handler: (req, p) => projectsApi.freeze(req, { id: p.id }) },
  { method: "POST", path: "/api/cut/projects/:id/watch", handler: (req, p) => projectsApi.watch(req, { id: p.id }) },
  { method: "POST", path: "/api/cut/projects/:id/silence", handler: (req, p) => projectsApi.silence(req, { id: p.id }) },
  { method: "POST", path: "/api/cut/projects/:id/audio", handler: (req, p) => projectsApi.audio(req, { id: p.id }) },
  { method: "POST", path: "/api/cut/projects/:id/duplicate", handler: (req, p) => projectsApi.duplicate(req, { id: p.id }) },
  { method: "GET", path: "/api/cut/projects/:id/preview", handler: (req, p) => projectsApi.servePreview(req, { id: p.id }) },

  { method: "GET", path: "/api/cut/library", handler: () => libraryApi.list() },
  { method: "POST", path: "/api/cut/library", handler: (req) => libraryApi.upload(req) },
  { method: "POST", path: "/api/cut/library/use", handler: (req) => libraryApi.use(req) },
  { method: "POST", path: "/api/cut/library/save", handler: (req) => libraryApi.save(req) },
  { method: "POST", path: "/api/cut/library/import-url", handler: (req) => libraryApi.importUrl(req) },
  { method: "POST", path: "/api/cut/library/move", handler: (req) => libraryApi.move(req) },
  { method: "POST", path: "/api/cut/library/templates", handler: (req) => libraryApi.saveTemplate(req) },
  { method: "POST", path: "/api/cut/library/templates/:id/use", handler: (req, p) => libraryApi.useTemplate(req, { id: p.id }) },
  { method: "POST", path: "/api/cut/library/templates/:id/add", handler: (req, p) => libraryApi.addToTemplate(req, { id: p.id }) },
  { method: "PUT", path: "/api/cut/library/templates/:id", handler: (req, p) => libraryApi.renameTemplate(req, { id: p.id }) },
  { method: "DELETE", path: "/api/cut/library/templates/:id", handler: (req, p) => libraryApi.removeTemplate(req, { id: p.id }) },
  { method: "POST", path: "/api/cut/library/folders", handler: (req) => libraryApi.createFolder(req) },
  { method: "PUT", path: "/api/cut/library/folders/:id", handler: (req, p) => libraryApi.renameFolder(req, { id: p.id }) },
  { method: "DELETE", path: "/api/cut/library/folders/:id", handler: (req, p) => libraryApi.deleteFolder(req, { id: p.id }) },
  { method: "GET", path: "/api/cut/library/media/:file", handler: (req, p) => libraryApi.serveMedia(req, { file: p.file }) },
  { method: "DELETE", path: "/api/cut/library/:id", handler: (req, p) => libraryApi.remove(req, { id: p.id }) },

  { method: "GET", path: "/api/cut/export-jobs", handler: () => exportApi.activeAll() },
  { method: "POST", path: "/api/cut/export", handler: (req) => exportApi.create(req) },
  { method: "GET", path: "/api/cut/export/:jobId", handler: (req, p) => exportApi.status(req, { jobId: p.jobId }) },
  { method: "DELETE", path: "/api/cut/export/:jobId", handler: (req, p) => exportApi.cancel(req, { jobId: p.jobId }) },
  { method: "GET", path: "/api/cut/export/:jobId/file", handler: (req, p) => exportApi.file(req, { jobId: p.jobId }) },

  { method: "POST", path: "/api/cut/stt", handler: (req) => sttApi.create(req) },
  { method: "GET", path: "/api/cut/stt/:jobId", handler: (req, p) => sttApi.status(req, { jobId: p.jobId }) },

  { method: "POST", path: "/api/cut/mic/start", handler: (req) => micApi.start(req) },
  { method: "POST", path: "/api/cut/mic/:id/feed", handler: (req, p) => micApi.feed(req, { id: p.id }) },
  { method: "GET", path: "/api/cut/mic/:id", handler: (req, p) => micApi.poll(req, { id: p.id }) },
  { method: "POST", path: "/api/cut/mic/:id/stop", handler: (req, p) => micApi.stop(req, { id: p.id }) },
  { method: "POST", path: "/api/cut/mic/:id/cancel", handler: (req, p) => micApi.cancel(req, { id: p.id }) },

  { method: "POST", path: "/api/cut/ai/chat", handler: (req) => aiApi.chat(req) },
  { method: "POST", path: "/api/cut/ai/captions", handler: (req) => aiApi.captions(req) },
  { method: "POST", path: "/api/cut/ai/visual-subtitles", handler: (req) => aiApi.visualSubtitles(req) },
  { method: "GET", path: "/api/cut/ai/models", handler: () => aiApi.models() },
  { method: "GET", path: "/api/cut/ai/proxy", handler: (req) => aiApi.proxyCatalog(req) },
  { method: "POST", path: "/api/cut/ai/proxy", handler: (req) => aiApi.proxyCall(req) },
  { method: "POST", path: "/api/cut/ai/tool-result", handler: (req) => aiApi.toolResult(req) },
];

export type RouteMatch =
  | { handler: TableHandler; params: Record<string, string>; head: boolean; scoped: boolean }
  | { methodNotAllowed: string[] };

/**
 * Run a matched route inside the requesting user's data scope. The page
 * appends the signed-in account id to every engine URL (api.ts); binding it
 * here — the one dispatch both mounts share — means every handler, and every
 * path built during it, is per-user by construction. A request without a
 * valid id never reaches a handler.
 */
export async function runCutRoute(
  req: Request,
  match: { handler: TableHandler; params: Record<string, string>; scoped: boolean }
): Promise<Response> {
  if (!match.scoped) return match.handler(req, match.params);
  const user = new URL(req.url).searchParams.get("u");
  if (!user || !isValidCutUser(user)) {
    return new Response(
      JSON.stringify({ error: "This page is out of date with the Donkey app — reload the tab." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  await adoptLegacyData(user);
  return runWithCutUser(user, () => match.handler(req, match.params));
}

/**
 * Match a request against the table via the shared matcher (http/match.ts):
 * static path segments win over dynamic ones, HEAD is served by the GET
 * handler, and a path that exists for other methods returns 405.
 */
export function matchCutRoute(method: string, pathname: string): RouteMatch | null {
  const match = matchRouteTable(CUT_ROUTES, method, pathname);
  if (!match) return null;
  if ("methodNotAllowed" in match) return match;
  return {
    handler: match.route.handler,
    params: match.params,
    head: match.head,
    scoped: match.route.scoped !== false,
  };
}
