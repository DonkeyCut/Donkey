// The hosted Cut API surface in one table, namespaced under /api/cut-cloud/*.
// The client's cloud driver rewrites /api/cut/X -> /api/cut-cloud/X, so paths
// mirror the engine table (http/routes.ts) with the cloud prefix, plus the
// cloud-only presign/job routes. Auth happens in the Next catch-all
// (withDonkeyAuth); every handler receives the session's userId and scopes
// every query by it.
import { type DonkeyAuthenticatedRequest, isDonkeySuperUser } from "@/lib/donkey-api-auth";
import { matchRouteTable, type RouteEntry } from "../http/match";
import { captionsCloud } from "./captions";
import { chatsCloud } from "./chats";
import { copyJobs } from "./copyQueue";
import { runGc } from "./gc";
import { jobsCloud } from "./jobs";
import { clipTitleCloud } from "./clipTitle";
import { libraryCloud } from "./library";
import { mediaCloud } from "./media";
import { notesCloud } from "./notes";
import { notePhoneClient, phoneApi } from "./phone";
import { projectsCloud } from "./projects";
import { turnsCloud } from "./turns";
import { shareCloud } from "./share";
import { transcribeCloud } from "./transcribe";
import { usageApi } from "./usage";
import { wantsDownload } from "./util";

type CloudHandler = (
  req: Request,
  userId: string,
  params: Record<string, string>
) => Response | Promise<Response>;

interface CloudRoute extends RouteEntry {
  handler: CloudHandler;
}

const CUT_CLOUD_ROUTES: CloudRoute[] = [
  { method: "GET", path: "/api/cut-cloud/projects", handler: (_r, u) => projectsCloud.list(u) },
  { method: "POST", path: "/api/cut-cloud/projects", handler: (r, u) => projectsCloud.create(u, r) },
  { method: "GET", path: "/api/cut-cloud/projects/folders", handler: (_r, u) => projectsCloud.folders(u) },
  { method: "POST", path: "/api/cut-cloud/projects/folders", handler: (r, u) => projectsCloud.createFolder(u, r) },
  { method: "PUT", path: "/api/cut-cloud/projects/folders/:id", handler: (r, u, p) => projectsCloud.updateFolder(u, p.id, r) },
  { method: "DELETE", path: "/api/cut-cloud/projects/folders/:id", handler: (_r, u, p) => projectsCloud.deleteFolder(u, p.id) },
  { method: "POST", path: "/api/cut-cloud/projects/:id/move", handler: (r, u, p) => projectsCloud.move(u, p.id, r) },
  { method: "GET", path: "/api/cut-cloud/projects/:id", handler: (_r, u, p) => projectsCloud.get(u, p.id) },
  { method: "PUT", path: "/api/cut-cloud/projects/:id", handler: (r, u, p) => projectsCloud.put(u, p.id, r) },
  { method: "DELETE", path: "/api/cut-cloud/projects/:id", handler: (_r, u, p) => projectsCloud.remove(u, p.id) },
  { method: "POST", path: "/api/cut-cloud/projects/:id/duplicate", handler: (_r, u, p) => copyJobs.requestDuplicate(u, p.id) },
  { method: "GET", path: "/api/cut-cloud/copy-jobs/:jobId", handler: (_r, u, p) => copyJobs.ownerStatus(u, p.jobId) },
  { method: "GET", path: "/api/cut-cloud/projects/:id/exports", handler: (_r, u, p) => projectsCloud.listExports(u, p.id) },
  // A render asked for by id alone: the worker builds the spec from the stored
  // document, for clients with no compositor of their own (the phone).
  { method: "POST", path: "/api/cut-cloud/projects/:id/export", handler: (r, u, p) => jobsCloud.exportFromDoc(u, p.id, r) },
  { method: "GET", path: "/api/cut-cloud/projects/:id/exports/:file", handler: (r, u, p) => projectsCloud.serveExport(u, p.id, p.file, wantsDownload(r)) },
  { method: "DELETE", path: "/api/cut-cloud/projects/:id/exports/:file", handler: (_r, u, p) => projectsCloud.removeExport(u, p.id, p.file) },
  { method: "GET", path: "/api/cut-cloud/projects/:id/media/:file", handler: (r, u, p) => projectsCloud.serveMedia(u, p.id, p.file, wantsDownload(r)) },
  { method: "DELETE", path: "/api/cut-cloud/projects/:id/media/:file", handler: (_r, u, p) => projectsCloud.removeMedia(u, p.id, p.file) },
  { method: "GET", path: "/api/cut-cloud/projects/:id/preview", handler: (_r, u, p) => projectsCloud.servePreview(u, p.id) },
  { method: "GET", path: "/api/cut-cloud/projects/:id/share", handler: (_r, u, p) => shareCloud.get(u, p.id) },
  { method: "PUT", path: "/api/cut-cloud/projects/:id/share", handler: (r, u, p) => shareCloud.put(u, p.id, r) },
  { method: "DELETE", path: "/api/cut-cloud/projects/:id/share", handler: (_r, u, p) => shareCloud.remove(u, p.id) },
  { method: "GET", path: "/api/cut-cloud/projects/:id/chats", handler: (_r, u, p) => chatsCloud.list(u, p.id) },
  { method: "PUT", path: "/api/cut-cloud/projects/:id/chats/:chatId", handler: (r, u, p) => chatsCloud.put(u, p.id, p.chatId, r) },
  { method: "DELETE", path: "/api/cut-cloud/projects/:id/chats/:chatId", handler: (_r, u, p) => chatsCloud.remove(u, p.id, p.chatId) },
  { method: "POST", path: "/api/cut-cloud/projects/:id/image", handler: (r, u, p) => mediaCloud.importImage(u, p.id, r) },
  { method: "POST", path: "/api/cut-cloud/projects/:id/media/presign", handler: (r, u, p) => mediaCloud.presign(u, p.id, r) },
  { method: "POST", path: "/api/cut-cloud/projects/:id/media/complete", handler: (r, u) => mediaCloud.complete(u, r) },
  { method: "POST", path: "/api/cut-cloud/projects/:id/import-url", handler: (r, u, p) => jobsCloud.importUrl(u, p.id, r) },
  { method: "POST", path: "/api/cut-cloud/projects/:id/convert", handler: (r, u, p) => jobsCloud.convert(u, p.id, r) },
  { method: "POST", path: "/api/cut-cloud/media/presign-get", handler: (r, u) => mediaCloud.presignGetBatch(u, r) },

  { method: "GET", path: "/api/cut-cloud/library", handler: (r, u) => libraryCloud.list(u, r) },
  { method: "POST", path: "/api/cut-cloud/library/presign", handler: (r, u) => libraryCloud.presign(u, r) },
  { method: "POST", path: "/api/cut-cloud/library/complete", handler: (r, u) => libraryCloud.complete(u, r) },
  { method: "POST", path: "/api/cut-cloud/library/presign-get", handler: (r, u) => libraryCloud.presignGetBatch(u, r) },
  { method: "POST", path: "/api/cut-cloud/library/use", handler: (r, u) => libraryCloud.use(u, r) },
  { method: "POST", path: "/api/cut-cloud/library/title", handler: (r, u) => clipTitleCloud.title(u, r) },
  { method: "POST", path: "/api/cut-cloud/library/save", handler: (r, u) => libraryCloud.save(u, r) },
  { method: "POST", path: "/api/cut-cloud/library/move", handler: (r, u) => libraryCloud.move(u, r) },
  { method: "POST", path: "/api/cut-cloud/library/templates", handler: (r, u) => libraryCloud.saveTemplate(u, r) },
  { method: "POST", path: "/api/cut-cloud/library/templates/import", handler: (r, u) => libraryCloud.importTemplate(u, r) },
  { method: "POST", path: "/api/cut-cloud/library/templates/:id/use", handler: (r, u, p) => libraryCloud.useTemplate(u, p.id, r) },
  { method: "POST", path: "/api/cut-cloud/library/templates/:id/add", handler: (r, u, p) => libraryCloud.addToTemplate(u, p.id, r) },
  { method: "PUT", path: "/api/cut-cloud/library/templates/:id", handler: (r, u, p) => libraryCloud.renameTemplate(u, p.id, r) },
  { method: "DELETE", path: "/api/cut-cloud/library/templates/:id", handler: (_r, u, p) => libraryCloud.removeTemplate(u, p.id) },
  { method: "POST", path: "/api/cut-cloud/library/import-url", handler: (r, u) => jobsCloud.importUrlToLibrary(u, r) },
  { method: "POST", path: "/api/cut-cloud/library/folders", handler: (r, u) => libraryCloud.createFolder(u, r) },
  { method: "PUT", path: "/api/cut-cloud/library/folders/:id", handler: (r, u, p) => libraryCloud.updateFolder(u, p.id, r) },
  { method: "DELETE", path: "/api/cut-cloud/library/folders/:id", handler: (_r, u, p) => libraryCloud.deleteFolder(u, p.id) },
  { method: "GET", path: "/api/cut-cloud/library/media/:file", handler: (r, u, p) => libraryCloud.serveMedia(u, p.file, wantsDownload(r)) },
  { method: "PUT", path: "/api/cut-cloud/library/:id", handler: (r, u, p) => libraryCloud.updateMeta(u, p.id, r) },
  { method: "DELETE", path: "/api/cut-cloud/library/:id", handler: (_r, u, p) => libraryCloud.remove(u, p.id) },

  { method: "GET", path: "/api/cut-cloud/export-jobs", handler: (_r, u) => jobsCloud.exportFeed(u) },
  { method: "POST", path: "/api/cut-cloud/export", handler: (r, u) => jobsCloud.exportCreate(u, r) },
  { method: "POST", path: "/api/cut-cloud/export/presign", handler: (r, u) => jobsCloud.exportPresign(u, r) },
  // A render the browser does itself: claim a name and a destination, then
  // register the finished file. No queue in between — the tab is the worker.
  { method: "POST", path: "/api/cut-cloud/export/client/presign", handler: (r, u) => jobsCloud.exportClientPresign(u, r) },
  { method: "POST", path: "/api/cut-cloud/export/client/complete", handler: (r, u) => jobsCloud.exportClientComplete(u, r) },
  { method: "POST", path: "/api/cut-cloud/export/client/:jobId/release", handler: (_r, u, p) => jobsCloud.exportClientRelease(u, p.jobId) },
  { method: "GET", path: "/api/cut-cloud/export/:jobId", handler: (_r, u, p) => jobsCloud.exportStatus(u, p.jobId) },
  { method: "DELETE", path: "/api/cut-cloud/export/:jobId", handler: (_r, u, p) => jobsCloud.exportCancel(u, p.jobId) },
  { method: "GET", path: "/api/cut-cloud/export/:jobId/file", handler: (_r, u, p) => jobsCloud.exportFile(u, p.jobId) },
  { method: "GET", path: "/api/cut-cloud/jobs/:jobId", handler: (_r, u, p) => jobsCloud.status(u, p.jobId) },
  { method: "POST", path: "/api/cut-cloud/projects/:id/turns", handler: (r, u, p) => turnsCloud.queue(u, p.id, r) },
  { method: "POST", path: "/api/cut-cloud/turns/:jobId/cancel", handler: (_r, u, p) => turnsCloud.cancel(u, p.jobId) },

  { method: "GET", path: "/api/cut-cloud/notes", handler: (_r, u) => notesCloud.list(u) },
  { method: "PUT", path: "/api/cut-cloud/notes/folders/:id", handler: (r, u, p) => notesCloud.putFolder(u, p.id, r) },
  { method: "DELETE", path: "/api/cut-cloud/notes/folders/:id", handler: (_r, u, p) => notesCloud.removeFolder(u, p.id) },
  { method: "PUT", path: "/api/cut-cloud/notes/labels/:id", handler: (r, u, p) => notesCloud.putLabel(u, p.id, r) },
  { method: "DELETE", path: "/api/cut-cloud/notes/labels/:id", handler: (_r, u, p) => notesCloud.removeLabel(u, p.id) },
  { method: "PUT", path: "/api/cut-cloud/notes/:id", handler: (r, u, p) => notesCloud.put(u, p.id, r) },
  { method: "DELETE", path: "/api/cut-cloud/notes/:id", handler: (_r, u, p) => notesCloud.remove(u, p.id) },
  { method: "GET", path: "/api/cut-cloud/phone", handler: (_r, u) => phoneApi.get(u) },

  { method: "POST", path: "/api/cut-cloud/transcribe", handler: (r, u) => transcribeCloud.transcribe(u, r) },
  { method: "POST", path: "/api/cut-cloud/ai/captions", handler: (r, u) => captionsCloud.captions(u, r) },
  { method: "POST", path: "/api/cut-cloud/ai/visual-subtitles", handler: (r, u) => captionsCloud.visualSubtitles(u, r) },
  { method: "GET", path: "/api/cut-cloud/usage", handler: (_r, u) => usageApi.get(u) },

  // GC also runs unauthenticated from the Vercel cron — see the catch-all
  // route, which checks the CRON_SECRET bearer token before auth. Any other
  // non-superuser caller sees a plain 404.
  {
    method: "GET",
    path: "/api/cut-cloud/gc",
    handler: async (_r, u) =>
      (await isDonkeySuperUser(u)) ? runGc() : new Response("Not found.", { status: 404 }),
  },

  // The engine's models probe reports local CLI availability; hosted Cut has
  // only the Gemini path (chat runs from the page on the user's account).
  {
    method: "GET",
    path: "/api/cut-cloud/ai/models",
    handler: () =>
      Response.json({
        providers: {
          gemini: { available: true, note: "runs on your Donkey account", installed: true },
        },
      }),
  },
];

export async function cutCloudCatchAll(req: DonkeyAuthenticatedRequest): Promise<Response> {
  const { pathname } = new URL(req.url);
  const match = matchRouteTable(CUT_CLOUD_ROUTES, req.method, pathname);
  if (!match) return new Response("Not found.", { status: 404 });
  if ("methodNotAllowed" in match) {
    return new Response("Method not allowed.", {
      status: 405,
      headers: { Allow: match.methodNotAllowed.join(", ") },
    });
  }
  notePhoneClient(req, req.donkey.userId);
  const res = await match.route.handler(req, req.donkey.userId, match.params);
  // A HEAD reply carries the GET headers but no body.
  if (match.head && res.body) {
    void res.body.cancel();
    return new Response(null, { status: res.status, headers: res.headers });
  }
  return res;
}
