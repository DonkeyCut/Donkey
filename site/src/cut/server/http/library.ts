import {
  addFromProject,
  addMediaToTemplate,
  addUpload,
  createFolder,
  deleteFolder,
  deleteTemplate,
  importTemplate,
  libMediaPath,
  listFolders,
  listLibrary,
  listTemplates,
  makeLibraryProxy,
  moveItem,
  removeAsset,
  updateFolder,
  renameAsset,
  renameTemplate,
  saveTemplate,
  copyLibraryAssetToProject,
  copyTemplateToProject,
  type LibraryAsset,
  type LibrarySource,
  type LinkedMeta,
  type TemplateInput,
} from "../library";
import { serveFileRange, wantsDownload } from "../serveFile";
import { importFromUrl } from "../urlImport";
import { UserError } from "../../lib/userError";
import { errorReply } from "../util";

const err = (failure: string | UserError, status: number) =>
  Response.json(errorReply(failure, ""), { status });
const caught = (e: unknown, fallback: string | UserError) =>
  Response.json(errorReply(e, fallback), { status: 500 });

/** Link imports by the key the page sent with them. A page that reloads
 * mid-import asks again under the same key and waits on the download already
 * running; one that asks after it landed gets the same assets back. A failure
 * is forgotten so a retry runs again. Landed keys are held as long as the
 * page resumes an import. */
const importsByKey = new Map<string, Promise<LibraryAsset[]>>();
const IMPORT_KEY_HOLD_MS = 30 * 60 * 1000;
const IMPORT_KEY = /^[A-Za-z0-9_-]{1,128}$/;

function importOnce(key: string | undefined, run: () => Promise<LibraryAsset[]>): Promise<LibraryAsset[]> {
  if (!key || !IMPORT_KEY.test(key)) {
    return run();
  }
  const running = importsByKey.get(key);
  if (running) {
    return running;
  }
  const started = run();
  importsByKey.set(key, started);
  started.then(
    () => setTimeout(() => importsByKey.delete(key), IMPORT_KEY_HOLD_MS).unref?.(),
    () => importsByKey.delete(key),
  );
  return started;
}

/** The shared library: reusable media outside any project. */
export const libraryApi = {
  async list() {
    const [assets, folders, templates] = await Promise.all([
      listLibrary(),
      listFolders(),
      listTemplates(),
    ]);
    return Response.json({ assets, folders, templates });
  },

  /** Save a timeline selection as a by-reference template. */
  async saveTemplate(req: Request) {
    try {
      const { projectId, ...input } = (await req.json()) as {
        projectId: string;
      } & TemplateInput;
      return Response.json(await saveTemplate(projectId, input));
    } catch (e) {
      return caught(e, new UserError("template_save_failed", "Could not save the template."));
    }
  },

  /** Take in a template carried off another shelf: its doc as `doc`, its media
   * as `file` parts in the doc's order. */
  async importTemplate(req: Request) {
    try {
      const form = await req.formData();
      const doc = JSON.parse(
        String(form.get("doc") ?? "{}"),
      ) as TemplateInput & {
        folderId?: string | null;
      };
      const files = form
        .getAll("file")
        .filter((f): f is File => f instanceof File);
      return Response.json(await importTemplate(doc, files));
    } catch (e) {
      return caught(e, new UserError("template_add_failed", "Could not add the template."));
    }
  },

  /** Materialize a template into a project (copies its media in). */
  async useTemplate(req: Request, { id }: { id: string }) {
    try {
      const { projectId } = (await req.json()) as { projectId: string };
      return Response.json(await copyTemplateToProject(id, projectId));
    } catch (e) {
      return caught(e, new UserError("template_add_failed", "Could not add the template."));
    }
  },

  /** Append a project media file to a template as one more part. */
  async addToTemplate(req: Request, { id }: { id: string }) {
    try {
      const { projectId, ...input } = (await req.json()) as {
        projectId: string;
      } & Parameters<typeof addMediaToTemplate>[2];
      return Response.json(await addMediaToTemplate(id, projectId, input));
    } catch (e) {
      return caught(e, new UserError("template_append_failed", "Could not add to the template."));
    }
  },

  async renameTemplate(req: Request, { id }: { id: string }) {
    try {
      const { name } = (await req.json()) as { name?: string };
      return Response.json(await renameTemplate(id, name ?? ""));
    } catch (e) {
      return caught(e, new UserError("template_rename_failed", "Could not rename the template."));
    }
  },

  /** Build the playable copy of a video the browser cannot decode. */
  async proxy(req: Request, { id }: { id: string }) {
    try {
      const body = (await req.json()) as { maxHeight?: number; crf?: number };
      if (!Number.isFinite(body.maxHeight) || !Number.isFinite(body.crf)) {
        return err("maxHeight and crf are required.", 400);
      }
      return Response.json(await makeLibraryProxy(id, { maxHeight: body.maxHeight!, crf: body.crf! }));
    } catch (e) {
      return caught(e, new UserError("playable_copy_make_failed", "Could not make the playable copy."));
    }
  },

  async rename(req: Request, { id }: { id: string }) {
    try {
      const { name } = (await req.json()) as { name?: string };
      return Response.json(await renameAsset(id, name ?? ""));
    } catch (e) {
      return caught(e, new UserError("file_rename_failed", "Could not rename the file."));
    }
  },

  async removeTemplate(_req: Request, { id }: { id: string }) {
    try {
      await deleteTemplate(id);
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, new UserError("template_delete_failed", "Could not delete the template."));
    }
  },

  /** Download a media URL straight into the library. */
  async importUrl(req: Request) {
    try {
      const { url, audio, key } = (await req.json()) as { url?: string; audio?: boolean; key?: string };
      if (!url) return err("No URL provided.", 400);
      return Response.json(await importOnce(key, () => importFromUrl(url, { audio: audio === true })));
    } catch (e) {
      return caught(e, new UserError("url_import_failed", "Could not import that URL."));
    }
  },

  async createFolder(req: Request) {
    try {
      const { name, parentId } = (await req.json()) as { name?: string; parentId?: string | null };
      return Response.json(await createFolder(name ?? "", parentId ?? null));
    } catch (e) {
      return caught(e, new UserError("folder_create_failed", "Could not create folder."));
    }
  },

  /** Rename a folder, move it under another, or both. */
  async updateFolder(req: Request, { id }: { id: string }) {
    try {
      const { name, parentId } = (await req.json()) as { name?: string; parentId?: string | null };
      return Response.json(await updateFolder(id, { name, parentId }));
    } catch (e) {
      return caught(e, new UserError("folder_update_failed", "Could not update folder."));
    }
  },

  async deleteFolder(_req: Request, { id }: { id: string }) {
    try {
      await deleteFolder(id);
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, new UserError("folder_delete_failed", "Could not delete folder."));
    }
  },

  /** Move an item — asset or template — into a folder (or `null` to ungroup). */
  async move(req: Request) {
    try {
      const { id, folderId } = (await req.json()) as {
        id: string;
        folderId: string | null;
      };
      await moveItem(id, folderId ?? null);
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, new UserError("library_item_move_failed", "Could not move item."));
    }
  },

  /** A file put on the shelf: an upload from the picker, or media the client
   * fetched elsewhere and is landing here — those carry the title, the source
   * they came from, and the source's cover alongside the bytes. */
  async upload(req: Request) {
    try {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return err("No file in upload.", 400);
      const name = form.get("name");
      const sourceField = form.get("source");
      let source: LibrarySource | undefined;
      if (typeof sourceField === "string" && sourceField)
        try {
          source = JSON.parse(sourceField) as LibrarySource;
        } catch {
          // Malformed notes are dropped; the media still lands.
        }
      const poster = form.get("poster");
      // A linked item's row fields (its content key, a LUT's facts) come from
      // the page that checked the file; the engine has no parser for them.
      const metaField = form.get("meta");
      let linked: LinkedMeta | undefined;
      if (typeof metaField === "string" && metaField)
        try {
          const meta = JSON.parse(metaField) as LinkedMeta;
          linked = {
            ...(typeof meta.contentKey === "string" ? { contentKey: meta.contentKey } : {}),
            ...(meta.lut ? { lut: meta.lut } : {}),
          };
        } catch {
          // Malformed fields are dropped; the file still lands.
        }
      return Response.json(
        await addUpload(
          file,
          typeof name === "string" ? name : undefined,
          source,
          poster instanceof File ? poster : undefined,
          linked,
          form.get("prepare") === "true",
        ),
      );
    } catch (e) {
      return caught(e, new UserError("upload_failed", "Upload failed."));
    }
  },

  async remove(_req: Request, { id }: { id: string }) {
    try {
      await removeAsset(id);
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, new UserError("library_delete_failed", "Could not delete."));
    }
  },

  /** Copy a library asset into a project's media folder. */
  async use(req: Request) {
    try {
      const { assetId, projectId } = (await req.json()) as {
        assetId: string;
        projectId: string;
      };
      const fileName = await copyLibraryAssetToProject(assetId, projectId);
      return Response.json({ fileName });
    } catch (e) {
      return caught(e, new UserError("library_add_failed", "Could not add from library."));
    }
  },

  /** Copy a project media file into the shared library. */
  async save(req: Request) {
    try {
      const { projectId, fileName, name } = (await req.json()) as {
        projectId: string;
        fileName: string;
        name?: string;
      };
      return Response.json(
        await addFromProject(projectId, fileName, name ?? fileName),
      );
    } catch (e) {
      return caught(e, new UserError("library_save_failed", "Could not save to library."));
    }
  },

  /** Raw library media file with Range support. */
  async serveMedia(req: Request, { file }: { file: string }) {
    let p: string;
    let name: string;
    try {
      name = decodeURIComponent(file);
      p = libMediaPath(name);
    } catch {
      return new Response("Bad request.", { status: 400 });
    }
    return serveFileRange(
      p,
      req,
      wantsDownload(req) ? { downloadName: name } : {},
    );
  },
};
