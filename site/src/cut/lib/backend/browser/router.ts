// The browser backend's route table: the engine's storage routes, served from
// the OPFS store in this page. The driver lazy-imports this module, so the
// engine bundle never pulls it in. Handlers mirror the engine's JSON shapes
// (`server/http/projects.ts`) — call sites can't tell which backend answered.
//
// Owned here: projects CRUD + folders, media bytes, image import, presign-get
// (answered with blob URLs), exports, the export-jobs feed, and the library
// shelf (./library.ts). Everything else is the driver's cloud proxy.
import { normalizeAspect, type ProjectDoc, type ProjectFolder } from "../../types";
import {
  getBrowserExportJob,
  listBrowserExportJobs,
  removeBrowserExportJob,
} from "./exportJobs";
import { dispatchLibraryRoute } from "./library";
import * as store from "./opfs";
import { registerBlobFile, registeredUrl, revokeRegistered } from "./registry";
import { caught, err, json, serveFile } from "./respond";

const mediaApiPath = (id: string, fileName: string) =>
  `/api/cut/projects/${id}/media/${encodeURIComponent(fileName)}`;
const exportApiPath = (id: string, fileName: string) =>
  `/api/cut/projects/${id}/exports/${encodeURIComponent(fileName)}`;

async function listSummaries(): Promise<Response> {
  const ids = await store.listProjectIds();
  const summaries = (
    await Promise.all(
      ids.map(async (id) => {
        const doc = await store.readDoc(id);
        return doc ? store.summarize(id, doc) : null;
      })
    )
  ).filter((s): s is NonNullable<typeof s> => s !== null);
  return json(summaries.sort((a, b) => b.updatedAt - a.updatedAt));
}

async function createProject(req: Request): Promise<Response> {
  try {
    const { name, folderId, aspect } = (await req.json()) as {
      name?: string;
      folderId?: string | null;
      aspect?: string;
    };
    const id = crypto.randomUUID().slice(0, 10);
    const displayName = (name ?? "Untitled").trim() || "Untitled";
    const folders = (await store.readIndex()).folders;
    const folder = folderId && folders.some((f) => f.id === folderId) ? folderId : null;
    const frame = normalizeAspect(aspect);
    const now = Date.now();
    const doc: ProjectDoc = {
      version: 1,
      id,
      name: displayName,
      createdAt: now,
      updatedAt: now,
      assets: [],
      clips: [],
      audioClips: [],
      overlays: [],
      ...(frame ? { aspect: frame } : {}),
      ...(folder ? { folderId: folder } : {}),
    };
    await store.writeDoc(id, doc);
    store.askPersist();
    return json(await store.summarize(id, doc));
  } catch (e) {
    return caught(e, "Could not create project.");
  }
}

/** The engine's PUT merge, field for field: arrays replace when sent, scalars
 * validate, `ui`/`publish`/`notes` shallow-merge, and a `clips` save with no
 * `overlayClips` clears the legacy array. */
async function putProject(req: Request, id: string): Promise<Response> {
  try {
    const existing = await store.readDoc(id);
    if (!existing) return err("Project not found.", 404);
    const body = (await req.json()) as Partial<ProjectDoc>;
    const doc: ProjectDoc = {
      ...existing,
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : existing.name,
      assets: Array.isArray(body.assets) ? body.assets : existing.assets,
      clips: Array.isArray(body.clips) ? body.clips : existing.clips,
      transitions: Array.isArray(body.transitions) ? body.transitions : existing.transitions,
      audioClips: Array.isArray(body.audioClips) ? body.audioClips : existing.audioClips,
      overlayClips: Array.isArray(body.overlayClips)
        ? body.overlayClips
        : Array.isArray(body.clips)
          ? []
          : existing.overlayClips,
      overlays: Array.isArray(body.overlays) ? body.overlays : existing.overlays,
      templates: Array.isArray(body.templates) ? body.templates : existing.templates,
      mediaFolders: Array.isArray(body.mediaFolders) ? body.mediaFolders : existing.mediaFolders,
      aspect: normalizeAspect(body.aspect) ?? existing.aspect,
      fadeIn: typeof body.fadeIn === "number" ? body.fadeIn : existing.fadeIn,
      fadeOut: typeof body.fadeOut === "number" ? body.fadeOut : existing.fadeOut,
      subtitles:
        body.subtitles && typeof body.subtitles === "object" ? body.subtitles : existing.subtitles,
      ui: body.ui && typeof body.ui === "object" ? { ...existing.ui, ...body.ui } : existing.ui,
      publish:
        body.publish && typeof body.publish === "object"
          ? { ...existing.publish, ...body.publish }
          : existing.publish,
      notes:
        body.notes && typeof body.notes === "object"
          ? { ...existing.notes, ...body.notes }
          : existing.notes,
      genvideo: body.genvideo !== undefined ? body.genvideo ?? undefined : existing.genvideo,
      renders: Array.isArray(body.renders) ? body.renders : existing.renders,
    };
    await store.writeDoc(id, doc);
    return json({ ok: true, updatedAt: doc.updatedAt });
  } catch (e) {
    return caught(e, "Could not save project.");
  }
}

async function duplicateProject(id: string): Promise<Response> {
  try {
    const doc = await store.readDoc(id);
    if (!doc) return err("Project not found.", 404);
    const newId = crypto.randomUUID().slice(0, 10);
    const now = Date.now();
    const copy: ProjectDoc = { ...doc, id: newId, name: `${doc.name} copy`, createdAt: now, updatedAt: now };
    await store.writeDoc(newId, copy);
    const srcMedia = await store.mediaDir(id);
    if (srcMedia) {
      for await (const [name, handle] of srcMedia) {
        if (handle.kind !== "file") continue;
        const file = await (handle as FileSystemFileHandle).getFile();
        await store.saveMedia(newId, file, name);
      }
    }
    return json(await store.summarize(newId, copy));
  } catch (e) {
    return caught(e, "Could not duplicate project.");
  }
}

async function moveProject(req: Request, id: string): Promise<Response> {
  try {
    const { folderId } = (await req.json()) as { folderId: string | null };
    const doc = await store.readDoc(id);
    if (!doc) return err("Project not found.", 404);
    if (folderId && !(await store.readIndex()).folders.some((f) => f.id === folderId)) {
      return err("Folder not found.", 404);
    }
    doc.folderId = folderId ?? null;
    await store.writeDoc(id, doc);
    return json({ ok: true });
  } catch (e) {
    return caught(e, "Could not move project.");
  }
}

async function createFolder(req: Request): Promise<Response> {
  try {
    const { name } = (await req.json()) as { name?: string };
    const trimmed = (name ?? "").trim();
    if (!trimmed) return err("Folder name required.", 500);
    const folder: ProjectFolder = {
      id: crypto.randomUUID().slice(0, 8),
      name: trimmed.slice(0, 80),
      createdAt: Date.now(),
    };
    await store.updateIndex((idx) => ({ ...idx, folders: [...idx.folders, folder] }));
    return json(folder);
  } catch (e) {
    return caught(e, "Could not create folder.");
  }
}

async function renameFolder(req: Request, fid: string): Promise<Response> {
  try {
    const { name } = (await req.json()) as { name?: string };
    const trimmed = (name ?? "").trim();
    if (!trimmed) return err("Folder name required.", 500);
    let renamed: ProjectFolder | null = null;
    await store.updateIndex((idx) => ({
      ...idx,
      folders: idx.folders.map((f) =>
        f.id === fid ? (renamed = { ...f, name: trimmed.slice(0, 80) }) : f
      ),
    }));
    return renamed ? json(renamed) : err("Folder not found.", 500);
  } catch (e) {
    return caught(e, "Could not rename folder.");
  }
}

async function deleteFolder(fid: string): Promise<Response> {
  try {
    await store.updateIndex((idx) => ({
      ...idx,
      folders: idx.folders.filter((f) => f.id !== fid),
    }));
    // Projects in the folder fall back to ungrouped rather than disappearing.
    for (const id of await store.listProjectIds()) {
      const doc = await store.readDoc(id);
      if (doc?.folderId === fid) {
        doc.folderId = null;
        await store.writeDoc(id, doc);
      }
    }
    return json({ ok: true });
  } catch (e) {
    return caught(e, "Could not delete folder.");
  }
}

async function uploadMedia(req: Request, id: string): Promise<Response> {
  try {
    if (!(await store.readDoc(id))) return err("Project not found.", 404);
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return err("No file in upload.", 400);
    const fileName = await store.saveMedia(id, file, file.name);
    registerBlobFile(mediaApiPath(id, fileName), file);
    return json({ fileName });
  } catch (e) {
    return caught(e, "Upload failed.");
  }
}

async function importImage(req: Request, id: string): Promise<Response> {
  try {
    if (!(await store.readDoc(id))) return err("Project not found.", 404);
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return err("No image in upload.", 400);
    const nameField = form.get("name");
    const name = typeof nameField === "string" && nameField.trim() ? nameField.trim() : file.name;
    const raw = form.get("origin");
    const origin = raw === "generated" || raw === "sticker" ? raw : undefined;
    const fileName = await store.saveMedia(id, file, file.name);
    registerBlobFile(mediaApiPath(id, fileName), file);
    let width = 0;
    let height = 0;
    try {
      const bmp = await createImageBitmap(file);
      width = bmp.width;
      height = bmp.height;
      bmp.close();
    } catch {
      // Undecodable here; the asset still lands, dims stay unknown like the
      // engine's probe failing.
    }
    return json({
      id: crypto.randomUUID().slice(0, 8),
      type: "image",
      name,
      fileName,
      duration: 0,
      width,
      height,
      ...(origin ? { origin } : {}),
    });
  } catch (e) {
    return caught(e, "Could not import the image.");
  }
}

/** Signed-URL mint, answered locally: every hit is a blob URL for the store's
 * own bytes. No `expiresIn` in the reply — blob URLs live as long as the page,
 * so the client's link-rotation clock stays off. */
async function presignGet(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { items?: { projectId: string; fileName: string }[] };
    const urls: { fileName: string; url: string }[] = [];
    for (const item of body.items ?? []) {
      if (!item?.projectId || !item?.fileName) continue;
      const path = mediaApiPath(item.projectId, item.fileName);
      let url = registeredUrl(path);
      if (!url) {
        const file = await store.readFileAt(await store.mediaDir(item.projectId), item.fileName);
        if (!file) continue;
        url = registerBlobFile(path, file);
      }
      urls.push({ fileName: item.fileName, url });
    }
    return json({ urls });
  } catch (e) {
    return caught(e, "Could not resolve media.");
  }
}

async function listProjectExports(id: string): Promise<Response> {
  const items = await store.listExports(id);
  // Register while listing so the shelf's players and download links resolve
  // synchronously through backend.url().
  for (const item of items) {
    const path = exportApiPath(id, item.file);
    if (!registeredUrl(path)) {
      const file = await store.readFileAt(await store.exportsDir(id), item.file);
      if (file) registerBlobFile(path, file);
    }
  }
  return json(items);
}

async function exportJobStatus(jobId: string): Promise<Response> {
  const job = getBrowserExportJob(jobId);
  if (!job) return err("Unknown export.", 404);
  return json({ status: job.status, progress: job.progress, error: job.error, outName: job.outName });
}

async function exportJobFile(jobId: string, download: boolean): Promise<Response> {
  const job = getBrowserExportJob(jobId);
  if (!job || job.status !== "done" || !job.outName) {
    return err("Export not ready.", 404);
  }
  const file = await store.readFileAt(await store.exportsDir(job.projectId), job.outName);
  if (!file) return err("Export not ready.", 404);
  return serveFile(file, job.outName, download);
}

/**
 * Serve one browser-backend request. Returns null for paths this router does
 * not own — the driver proxies those to the hosted twin.
 */
export async function dispatchBrowserRoute(
  path: string,
  init?: RequestInit
): Promise<Response | null> {
  const url = new URL(path, "http://cut.browser");
  const seg = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (seg[0] !== "api" || seg[1] !== "cut") return null;
  const rest = seg.slice(2);
  const method = (init?.method ?? "GET").toUpperCase();
  const req = () => new Request(url, init);
  const download = url.searchParams.has("download");

  if (rest[0] === "projects") {
    // /projects
    if (rest.length === 1) {
      if (method === "GET") return listSummaries();
      if (method === "POST") return createProject(req());
      return err("Method not allowed.", 405);
    }
    // /projects/folders[/:fid]
    if (rest[1] === "folders") {
      if (rest.length === 2) {
        if (method === "GET") {
          const { folders } = await store.readIndex();
          return json([...folders].sort((a, b) => a.createdAt - b.createdAt));
        }
        if (method === "POST") return createFolder(req());
        return err("Method not allowed.", 405);
      }
      if (rest.length === 3) {
        if (method === "PUT") return renameFolder(req(), rest[2]);
        if (method === "DELETE") return deleteFolder(rest[2]);
        return err("Method not allowed.", 405);
      }
      return err("Not found.", 404);
    }
    const id = rest[1];
    // /projects/:id
    if (rest.length === 2) {
      if (method === "HEAD" || method === "GET") {
        const doc = await store.readDoc(id);
        if (!doc) return err("Project not found.", 404);
        return method === "HEAD" ? new Response(null, { status: 200 }) : json(doc);
      }
      if (method === "PUT") return putProject(req(), id);
      if (method === "DELETE") {
        await store.deleteProject(id);
        revokeRegistered(`/api/cut/projects/${id}/`);
        return json({ ok: true });
      }
      return err("Method not allowed.", 405);
    }
    // /projects/:id/<action>
    if (rest.length === 3) {
      if (rest[2] === "duplicate" && method === "POST") return duplicateProject(id);
      if (rest[2] === "move" && method === "POST") return moveProject(req(), id);
      if (rest[2] === "media" && method === "POST") return uploadMedia(req(), id);
      if (rest[2] === "image" && method === "POST") return importImage(req(), id);
      if (rest[2] === "exports" && method === "GET") return listProjectExports(id);
    }
    // /projects/:id/media/:file | /projects/:id/exports/:file
    if (rest.length === 4 && (rest[2] === "media" || rest[2] === "exports")) {
      const dir = rest[2] === "media" ? await store.mediaDir(id) : await store.exportsDir(id);
      const fileName = rest[3];
      if (method === "GET") {
        const file = await store.readFileAt(dir, fileName);
        if (!file) return err(`${rest[2] === "media" ? "Media file" : "Export"} not found.`, 404);
        const apiPath =
          rest[2] === "media" ? mediaApiPath(id, fileName) : exportApiPath(id, fileName);
        if (!registeredUrl(apiPath)) registerBlobFile(apiPath, file);
        return serveFile(file, fileName, download);
      }
      if (method === "DELETE") {
        if (rest[2] === "media") await store.deleteMedia(id, fileName);
        else await store.deleteExport(id, fileName);
        revokeRegistered(
          rest[2] === "media" ? mediaApiPath(id, fileName) : exportApiPath(id, fileName)
        );
        return json({ ok: true });
      }
      return err("Method not allowed.", 405);
    }
    // Engine-only compute under /projects (freeze, silence, transcribe, …):
    // no browser implementation, answered like the cloud twin answers them.
    return err("Not available for browser projects.", 404);
  }

  if (rest[0] === "library") {
    return dispatchLibraryRoute(rest.slice(1), method, req, download);
  }

  if (rest[0] === "media" && rest[1] === "presign-get" && method === "POST") {
    return presignGet(req());
  }

  if (rest[0] === "export-jobs" && method === "GET") {
    return json(listBrowserExportJobs());
  }

  if (rest[0] === "export" && rest.length >= 2) {
    const jobId = rest[1];
    if (rest.length === 2 && method === "GET") return exportJobStatus(jobId);
    if (rest.length === 2 && method === "DELETE") {
      removeBrowserExportJob(jobId);
      return json({ ok: true });
    }
    if (rest.length === 3 && rest[2] === "file" && method === "GET") {
      return exportJobFile(jobId, download);
    }
    return err("Not found.", 404);
  }

  return null;
}
