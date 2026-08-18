// The browser shelf's library: reusable media outside any project, held in
// this page's own storage. Handlers answer the engine's `/api/cut/library`
// routes (`server/http/library.ts`) with the same JSON, so a call site can't
// tell which shelf it reached.
//
// The whole shelf is one index file next to a media folder. Templates keep
// private copies of their media here, the way the engine's do, so a template
// stays whole after the project it came from is gone.
//
// Not owned here: `import-url`, `presign` and `complete`. A page can't fetch a
// video off a link, so that import runs on the cloud worker and the bytes are
// adopted afterwards (`lib/library.ts`); those paths fall through to the
// hosted twin.
import type {
  AssetType,
  LibraryTemplate,
  TemplateAudio,
  TemplateLayer,
  TemplateMedia,
} from "../../types";
import * as store from "./opfs";
import { registerBlobFile, registeredUrl, revokeRegistered } from "./registry";
import { caught, err, json, serveFile } from "./respond";

const INDEX_FILE = "library.json";

export const libraryMediaApiPath = (fileName: string) =>
  `/api/cut/library/media/${encodeURIComponent(fileName)}`;

const projectMediaApiPath = (id: string, fileName: string) =>
  `/api/cut/projects/${id}/media/${encodeURIComponent(fileName)}`;

/** Where a URL-imported asset came from, kept as notes on the asset. */
type LibrarySource = { url: string; title?: string; uploader?: string; uploadDate?: string };

type StoredAsset = {
  id: string;
  fileName: string;
  name: string;
  type: AssetType;
  duration: number;
  width?: number;
  height?: number;
  addedAt: number;
  folderId?: string | null;
  source?: LibrarySource;
  /** The source's cover image, stored beside the media and served by the same
   * route — an import from a site that publishes one carries it. */
  posterFile?: string;
};

type StoredFolder = { id: string; name: string; createdAt: number };

type LibraryIndex = {
  version: 1;
  assets: StoredAsset[];
  folders: StoredFolder[];
  templates: LibraryTemplate[];
};

const EMPTY: LibraryIndex = { version: 1, assets: [], folders: [], templates: [] };

async function readIndex(): Promise<LibraryIndex> {
  const idx = await store.readJson<LibraryIndex>(await store.libraryDir(), INDEX_FILE);
  if (!idx) return EMPTY;
  return {
    version: 1,
    assets: Array.isArray(idx.assets) ? idx.assets : [],
    folders: Array.isArray(idx.folders) ? idx.folders : [],
    templates: Array.isArray(idx.templates) ? idx.templates : [],
  };
}

/** Read-modify-write the shelf under the store lock, so two tabs filing items
 * at once can't clobber each other's index. */
async function mutateIndex<T>(fn: (idx: LibraryIndex) => T): Promise<T> {
  return store.withStoreLock("library", async () => {
    const dir = await store.libraryDir(true);
    if (!dir) throw new Error("Browser storage is unavailable.");
    const idx = await readIndex();
    const result = fn(idx);
    await store.writeFileAt(dir, INDEX_FILE, JSON.stringify(idx));
    return result;
  });
}

const VIDEO_RE = /\.(mp4|mov|m4v|webm|mkv)$/i;
const AUDIO_RE = /\.(mp3|m4a|aac|wav|ogg|flac)$/i;
const IMAGE_RE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;
const FONT_RE = /\.(ttf|otf|woff2?)$/i;

function typeOf(fileName: string): AssetType | null {
  if (VIDEO_RE.test(fileName)) return "video";
  if (AUDIO_RE.test(fileName)) return "audio";
  if (IMAGE_RE.test(fileName)) return "image";
  if (FONT_RE.test(fileName)) return "font";
  return null;
}

function parseField<T>(value: FormDataEntryValue | null): T | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/** Mint the blob URL for a library file so `backend.url()` answers for it
 * without awaiting. */
async function register(fileName: string, file?: File | null): Promise<void> {
  const path = libraryMediaApiPath(fileName);
  if (registeredUrl(path)) return;
  const bytes = file ?? (await store.readFileAt(await store.libraryMediaDir(), fileName));
  if (bytes) registerBlobFile(path, bytes);
}

/** The whole shelf, with every file it holds registered so cards, players and
 * download links resolve synchronously. */
async function list(): Promise<Response> {
  const idx = await readIndex();
  for (const name of new Set([
    ...idx.assets.map((a) => a.fileName),
    ...idx.assets.flatMap((a) => (a.posterFile ? [a.posterFile] : [])),
    ...idx.templates.flatMap((t) => t.media.map((m) => m.fileName)),
  ])) {
    await register(name);
  }
  return json({
    assets: [...idx.assets].sort((a, b) => b.addedAt - a.addedAt),
    folders: [...idx.folders].sort((a, b) => a.createdAt - b.createdAt),
    templates: [...idx.templates].sort((a, b) => b.addedAt - a.addedAt),
  });
}

/** Write the row for a file already stored in the library. */
async function addAsset(
  fileName: string,
  name: string,
  meta: { type?: AssetType; duration?: number; width?: number; height?: number } | null,
  source?: LibrarySource | null,
  posterFile?: string
): Promise<StoredAsset> {
  const type = meta?.type ?? typeOf(fileName);
  if (!type) throw new Error("Unsupported file type.");
  const asset: StoredAsset = {
    id: crypto.randomUUID().slice(0, 8),
    fileName,
    name,
    type,
    duration: meta?.duration ?? 0,
    ...(meta?.width && meta?.height ? { width: meta.width, height: meta.height } : {}),
    addedAt: Date.now(),
    folderId: null,
    ...(source ? { source } : {}),
    ...(posterFile ? { posterFile } : {}),
  };
  await mutateIndex((idx) => {
    idx.assets.push(asset);
  });
  return asset;
}

/**
 * Upload straight onto the shelf. The page probes the file before sending it
 * (`meta`), because nothing here can read a duration out of stored bytes the
 * way the engine's ffprobe can.
 */
async function upload(req: Request): Promise<Response> {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return err("No file in upload.", 400);
    const nameField = form.get("name");
    const name = typeof nameField === "string" && nameField.trim() ? nameField.trim() : file.name;
    const meta = parseField<{
      type?: AssetType;
      duration?: number;
      width?: number;
      height?: number;
    }>(form.get("meta"));
    const source = parseField<LibrarySource>(form.get("source"));
    if (!(meta?.type ?? typeOf(file.name))) return err("Unsupported file type.", 400);
    const fileName = await store.saveLibraryMedia(file, file.name);
    await register(fileName, file);
    // An import carries the source's cover alongside the media; it is stored
    // like any other library file and named after the media it belongs to.
    const posterField = form.get("poster");
    let posterFile: string | undefined;
    if (posterField instanceof File) {
      const ext = posterField.name.match(/\.[a-z0-9]+$/i)?.[0] ?? ".jpg";
      posterFile = await store.saveLibraryMedia(posterField, `${fileName}.poster${ext}`);
      await register(posterFile, posterField);
    }
    return json(await addAsset(fileName, name, meta, source, posterFile));
  } catch (e) {
    return caught(e, "Upload failed.");
  }
}

async function serveMedia(fileName: string, download: boolean): Promise<Response> {
  const file = await store.readFileAt(await store.libraryMediaDir(), fileName);
  if (!file) return err("Media file not found.", 404);
  await register(fileName, file);
  return serveFile(file, fileName, download);
}

async function removeAsset(id: string): Promise<Response> {
  try {
    const { fileName, posterFile } = await mutateIndex((idx) => {
      const asset = idx.assets.find((a) => a.id === id);
      if (!asset) throw new Error("Library asset not found.");
      idx.assets = idx.assets.filter((a) => a.id !== id);
      return { fileName: asset.fileName, posterFile: asset.posterFile };
    });
    await store.deleteLibraryMedia(fileName);
    revokeRegistered(libraryMediaApiPath(fileName));
    if (posterFile) {
      await store.deleteLibraryMedia(posterFile).catch(() => {});
      revokeRegistered(libraryMediaApiPath(posterFile));
    }
    return json({ ok: true });
  } catch (e) {
    return caught(e, "Could not delete.");
  }
}

async function move(req: Request): Promise<Response> {
  try {
    const { id, folderId } = (await req.json()) as { id: string; folderId: string | null };
    await mutateIndex((idx) => {
      const item = idx.assets.find((a) => a.id === id) ?? idx.templates.find((t) => t.id === id);
      if (!item) throw new Error("Library item not found.");
      if (folderId && !idx.folders.some((f) => f.id === folderId)) {
        throw new Error("Folder not found.");
      }
      item.folderId = folderId ?? null;
    });
    return json({ ok: true });
  } catch (e) {
    return caught(e, "Could not move item.");
  }
}

async function createFolder(req: Request): Promise<Response> {
  try {
    const { name } = (await req.json()) as { name?: string };
    const trimmed = (name ?? "").trim();
    if (!trimmed) return err("Folder name required.", 500);
    const folder: StoredFolder = {
      id: crypto.randomUUID().slice(0, 8),
      name: trimmed.slice(0, 80),
      createdAt: Date.now(),
    };
    await mutateIndex((idx) => {
      idx.folders.push(folder);
    });
    return json(folder);
  } catch (e) {
    return caught(e, "Could not create folder.");
  }
}

async function renameFolder(req: Request, id: string): Promise<Response> {
  try {
    const { name } = (await req.json()) as { name?: string };
    const trimmed = (name ?? "").trim();
    if (!trimmed) return err("Folder name required.", 500);
    return json(
      await mutateIndex((idx) => {
        const folder = idx.folders.find((f) => f.id === id);
        if (!folder) throw new Error("Folder not found.");
        folder.name = trimmed.slice(0, 80);
        return folder;
      })
    );
  } catch (e) {
    return caught(e, "Could not rename folder.");
  }
}

async function deleteFolder(id: string): Promise<Response> {
  try {
    await mutateIndex((idx) => {
      idx.folders = idx.folders.filter((f) => f.id !== id);
      // Items in the folder fall back to ungrouped rather than vanishing.
      for (const a of idx.assets) if (a.folderId === id) a.folderId = null;
      for (const t of idx.templates) if (t.folderId === id) t.folderId = null;
    });
    return json({ ok: true });
  } catch (e) {
    return caught(e, "Could not delete folder.");
  }
}

/** Copy a library file into a project's media folder. */
async function copyIntoProject(projectId: string, fileName: string): Promise<string> {
  const file = await store.readFileAt(await store.libraryMediaDir(), fileName);
  if (!file) throw new Error("Library file not found.");
  const stored = await store.saveMedia(projectId, file, fileName);
  registerBlobFile(projectMediaApiPath(projectId, stored), file);
  return stored;
}

/** Copy a project's media file onto the shelf. */
async function copyFromProject(projectId: string, fileName: string): Promise<string> {
  const file = await store.readFileAt(await store.mediaDir(projectId), fileName);
  if (!file) throw new Error("Media file not found in project.");
  const stored = await store.saveLibraryMedia(file, fileName);
  await register(stored, file);
  return stored;
}

async function addToProject(req: Request): Promise<Response> {
  try {
    const { assetId, projectId } = (await req.json()) as { assetId: string; projectId: string };
    const asset = (await readIndex()).assets.find((a) => a.id === assetId);
    if (!asset) return err("Library asset not found.", 404);
    if (!(await store.readDoc(projectId))) return err("Project not found.", 404);
    return json({ fileName: await copyIntoProject(projectId, asset.fileName) });
  } catch (e) {
    return caught(e, "Could not add from library.");
  }
}

/**
 * Save a project's media file onto the shelf. The doc is right here, so the
 * asset's own row supplies the dimensions and duration the page would
 * otherwise have to re-probe.
 */
async function saveFromProject(req: Request): Promise<Response> {
  try {
    const { projectId, fileName, name } = (await req.json()) as {
      projectId: string;
      fileName: string;
      name?: string;
    };
    const doc = await store.readDoc(projectId);
    if (!doc) return err("Project not found.", 404);
    const known = doc.assets.find((a) => a.fileName === fileName);
    const stored = await copyFromProject(projectId, fileName);
    return json(
      await addAsset(stored, name || fileName, {
        type: known?.type as AssetType | undefined,
        duration: known?.duration,
        width: known?.width,
        height: known?.height,
      })
    );
  } catch (e) {
    return caught(e, "Could not save to library.");
  }
}

// --- templates: selections saved by reference, media copied in privately ---

type TemplateInput = {
  name: string;
  duration: number;
  media: TemplateMedia[];
  layers: TemplateLayer[];
  audio: TemplateAudio[];
  texts: LibraryTemplate["texts"];
  cues: LibraryTemplate["cues"];
};

async function saveTemplate(req: Request): Promise<Response> {
  try {
    const { projectId, ...input } = (await req.json()) as { projectId: string } & TemplateInput;
    if (!(await store.readDoc(projectId))) return err("Project not found.", 404);
    if (!input.media?.length && !input.texts?.length && !input.cues?.length) {
      return err("Nothing to save.", 500);
    }
    const media: TemplateMedia[] = [];
    for (const m of input.media ?? []) {
      media.push({ ...m, fileName: await copyFromProject(projectId, m.fileName) });
    }
    const template: LibraryTemplate = {
      id: crypto.randomUUID().slice(0, 8),
      name: (input.name || "Template").trim().slice(0, 80),
      addedAt: Date.now(),
      duration: input.duration,
      media,
      layers: input.layers ?? [],
      audio: input.audio ?? [],
      texts: input.texts ?? [],
      cues: input.cues ?? [],
    };
    await mutateIndex((idx) => {
      idx.templates.push(template);
    });
    return json(template);
  } catch (e) {
    return caught(e, "Could not save the template.");
  }
}

async function materializeTemplate(req: Request, id: string): Promise<Response> {
  try {
    const { projectId } = (await req.json()) as { projectId: string };
    if (!(await store.readDoc(projectId))) return err("Project not found.", 404);
    const template = (await readIndex()).templates.find((t) => t.id === id);
    if (!template) return err("Template not found.", 404);
    const media: TemplateMedia[] = [];
    for (const m of template.media) {
      media.push({ ...m, fileName: await copyIntoProject(projectId, m.fileName) });
    }
    return json({ template, media });
  } catch (e) {
    return caught(e, "Could not add the template.");
  }
}

async function addToTemplate(req: Request, id: string): Promise<Response> {
  try {
    const { projectId, media, layer, audio, extend } = (await req.json()) as {
      projectId: string;
      media: TemplateMedia;
      layer?: Omit<TemplateLayer, "media" | "start">;
      audio?: Omit<TemplateAudio, "media" | "start">;
      extend: number;
    };
    const stored = await copyFromProject(projectId, media.fileName);
    try {
      return json(
        await mutateIndex((idx) => {
          const t = idx.templates.find((x) => x.id === id);
          if (!t) throw new Error("Template not found.");
          const mi = t.media.length;
          t.media = [...t.media, { ...media, fileName: stored }];
          if (audio) t.audio = [...t.audio, { ...audio, media: mi, start: t.duration }];
          else if (layer) t.layers = [...t.layers, { ...layer, media: mi, start: t.duration }];
          t.duration += extend;
          return t;
        })
      );
    } catch (e) {
      await store.deleteLibraryMedia(stored);
      throw e;
    }
  } catch (e) {
    return caught(e, "Could not add to the template.");
  }
}

async function renameTemplate(req: Request, id: string): Promise<Response> {
  try {
    const { name } = (await req.json()) as { name?: string };
    const trimmed = (name ?? "").trim();
    if (!trimmed) return err("Template name required.", 500);
    return json(
      await mutateIndex((idx) => {
        const template = idx.templates.find((t) => t.id === id);
        if (!template) throw new Error("Template not found.");
        template.name = trimmed.slice(0, 80);
        return template;
      })
    );
  } catch (e) {
    return caught(e, "Could not rename the template.");
  }
}

async function deleteTemplate(id: string): Promise<Response> {
  try {
    const template = await mutateIndex((idx) => {
      const t = idx.templates.find((x) => x.id === id);
      idx.templates = idx.templates.filter((x) => x.id !== id);
      return t;
    });
    // A template's media copies are private to it, so they go with it.
    for (const m of template?.media ?? []) {
      await store.deleteLibraryMedia(m.fileName);
      revokeRegistered(libraryMediaApiPath(m.fileName));
    }
    return json({ ok: true });
  } catch (e) {
    return caught(e, "Could not delete the template.");
  }
}

/**
 * Serve one `/api/cut/library/...` request against this browser's shelf.
 * `rest` is the path past `library`. Returns null for the paths the shelf
 * doesn't own, which the driver proxies to the hosted twin.
 */
export async function dispatchLibraryRoute(
  rest: string[],
  method: string,
  req: () => Request,
  download: boolean
): Promise<Response | null> {
  // /library
  if (rest.length === 0) {
    if (method === "GET") return list();
    if (method === "POST") return upload(req());
    return err("Method not allowed.", 405);
  }

  // /library/media/:file
  if (rest[0] === "media" && rest.length === 2) {
    if (method === "GET") return serveMedia(rest[1], download);
    return err("Method not allowed.", 405);
  }

  if (rest[0] === "folders") {
    if (rest.length === 1 && method === "POST") return createFolder(req());
    if (rest.length === 2 && method === "PUT") return renameFolder(req(), rest[1]);
    if (rest.length === 2 && method === "DELETE") return deleteFolder(rest[1]);
    return err("Not found.", 404);
  }

  if (rest[0] === "templates") {
    if (rest.length === 1 && method === "POST") return saveTemplate(req());
    if (rest.length === 2 && method === "PUT") return renameTemplate(req(), rest[1]);
    if (rest.length === 2 && method === "DELETE") return deleteTemplate(rest[1]);
    if (rest.length === 3 && method === "POST") {
      if (rest[2] === "use") return materializeTemplate(req(), rest[1]);
      if (rest[2] === "add") return addToTemplate(req(), rest[1]);
    }
    return err("Not found.", 404);
  }

  if (rest.length === 1 && method === "POST") {
    if (rest[0] === "move") return move(req());
    if (rest[0] === "use") return addToProject(req());
    if (rest[0] === "save") return saveFromProject(req());
    // import-url, presign, complete: the cloud's, not this shelf's.
    return null;
  }

  // /library/:id
  if (rest.length === 1 && method === "DELETE") return removeAsset(rest[0]);
  return null;
}
