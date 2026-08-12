"use client";

import { apiJson, getBackend } from "./backend";
import { readSnapshot, writeSnapshot } from "./cache";
import { downloadFromUrl } from "./download";
import {
  enrichAsset,
  importRemote,
  presignedUpload,
  probeFileMeta,
  uploadProjectMediaTo,
} from "./media";
import {
  activeResidency,
  availableResidencies,
  backendFor,
  libraryShelfKey,
  listedResidencies,
  type Residency,
} from "./residency";
import { useEditor } from "./store";
import { playheadAt } from "./playhead";
import type { LibraryTemplate, MediaAsset, TemplateMedia, TemplateSaveInput } from "./types";
import { IMAGE_CLIP_SECONDS, mediaUrl } from "./types";

export interface LibrarySource {
  url: string;
  title?: string;
  uploader?: string;
  uploadDate?: string;
}

export interface LibraryAsset {
  id: string;
  fileName: string;
  name: string;
  type: "video" | "audio" | "image";
  duration: number;
  width?: number;
  height?: number;
  addedAt: number;
  folderId?: string | null;
  source?: LibrarySource;
  /** Which shelf this came off. Stamped on arrival — the servers each answer
   * for themselves and don't know the other exists. */
  residency: Residency;
}

export interface LibraryFolder {
  id: string;
  name: string;
  createdAt: number;
  residency: Residency;
}

/** A template as the library lists it: the stored doc plus the shelf it sits
 * on, so its media resolve against the right backend. */
export type LibraryTemplateItem = LibraryTemplate & { residency: Residency };

export interface LibraryData {
  assets: LibraryAsset[];
  folders: LibraryFolder[];
  templates: LibraryTemplateItem[];
}

export const libraryMediaUrl = (fileName: string, residency: Residency) =>
  backendFor(residency).url(`/api/cut/library/media/${encodeURIComponent(fileName)}`);

/** Save a library file to the user's Downloads folder, off the shelf it sits
 * on. */
export function downloadLibraryAsset(a: Pick<LibraryAsset, "fileName" | "residency">) {
  downloadFromUrl(libraryMediaUrl(a.fileName, a.residency), a.fileName);
}

async function fetchLibraryFrom(r: Residency): Promise<LibraryData> {
  const res = await backendFor(r).fetch("/api/cut/library");
  if (!res.ok) throw new Error("Could not load the library.");
  const data = (await res.json()) as LibraryData;
  const shelf: LibraryData = {
    assets: (data.assets ?? []).map((a) => ({ ...a, residency: r })),
    folders: (data.folders ?? []).map((f) => ({ ...f, residency: r })),
    templates: (data.templates ?? []).map((t) => ({ ...t, residency: r })),
  };
  // Each half is stored on its own, so one can be recalled while the other is
  // re-read: that is what keeps the Mac's shelf listed with the app closed.
  writeSnapshot(libraryShelfKey(r), shelf);
  return shelf;
}

/** One shelf as this browser last saw it, for a residency it can't ask right
 * now. Those files are still on that Mac; only the way to reach them is gone. */
async function rememberedLibraryFrom(r: Residency): Promise<LibraryData | null> {
  const hit = await readSnapshot<LibraryData>(libraryShelfKey(r));
  return hit?.value ?? null;
}

/**
 * The whole shelf: every residency's library in one listing, newest first. A
 * residency that fails is left out rather than failing the read — one
 * unreachable half never hides the other; only both failing is an error.
 *
 * `remembered` widens that from what this browser can reach to what the user
 * has: a shelf whose backend isn't answering is recalled from its last
 * listing. The Library tab asks for it, because those items exist and the user
 * is entitled to see them; the editor's library picker doesn't, because an
 * item it can't copy into the project has no business in a picker.
 */
export async function fetchLibrary(opts?: { remembered?: boolean }): Promise<LibraryData> {
  const live = availableResidencies();
  const rs = opts?.remembered ? listedResidencies() : live;
  const parts = await Promise.all(
    rs.map((r) =>
      live.includes(r) ? fetchLibraryFrom(r).catch(() => null) : rememberedLibraryFrom(r)
    )
  );
  const got = parts.filter((p): p is LibraryData => p !== null);
  if (got.length === 0) throw new Error("Could not load the library.");
  const byNewest = <T extends { addedAt: number }>(items: T[]) =>
    [...items].sort((a, b) => b.addedAt - a.addedAt);
  return {
    assets: byNewest(got.flatMap((p) => p.assets)),
    folders: got.flatMap((p) => p.folders).sort((a, b) => a.createdAt - b.createdAt),
    templates: byNewest(got.flatMap((p) => p.templates)),
  };
}

export async function importUrlToLibrary(
  url: string,
  residency: Residency = activeResidency()
): Promise<LibraryAsset[]> {
  const res = await backendFor(residency).fetch("/api/cut/library/import-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const body = await apiJson<LibraryAsset[]>(res);
  if (!res.ok) throw new Error(body.error ?? "Could not import that URL.");
  return (Array.isArray(body) ? body : []).map((a) => ({ ...a, residency }));
}

export async function createLibraryFolder(
  name: string,
  residency: Residency = activeResidency()
): Promise<LibraryFolder> {
  const res = await backendFor(residency).fetch("/api/cut/library/folders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const body = await apiJson<LibraryFolder>(res);
  if (!res.ok) throw new Error(body.error ?? "Could not create folder.");
  return { ...body, residency };
}

export async function renameLibraryFolder(
  residency: Residency,
  id: string,
  name: string
): Promise<void> {
  const res = await backendFor(residency).fetch(`/api/cut/library/folders/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error("Could not rename folder.");
}

export async function deleteLibraryFolder(residency: Residency, id: string): Promise<void> {
  const res = await backendFor(residency).fetch(`/api/cut/library/folders/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Could not delete folder.");
}

/** File a library item — an asset or a template — into a folder on its own
 * shelf (`null` ungroups). Folders don't span residencies: a cloud item can't
 * move into a folder that lives on the Mac. */
export async function moveLibraryItem(
  residency: Residency,
  id: string,
  folderId: string | null
): Promise<void> {
  const res = await backendFor(residency).fetch("/api/cut/library/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, folderId }),
  });
  if (!res.ok) throw new Error("Could not move item.");
}

export async function uploadToLibrary(
  file: File,
  residency: Residency = activeResidency()
): Promise<LibraryAsset> {
  const backend = backendFor(residency);
  if (residency === "cloud") {
    // Presign -> direct R2 PUT -> complete, with the media probed here — the
    // cloud can't cheaply probe an R2 object the way the engine probes disk.
    // A file this browser can't decode would land as a zero-length asset it
    // also couldn't preview, so reject it before any bytes go up.
    const meta = await probeFileMeta(file).catch(() => null);
    if (!meta || (meta.type !== "image" && !(meta.duration > 0))) {
      throw new Error(
        "This file can't be read in this browser, so it can't go in the cloud library. Import it in the Mac app instead."
      );
    }
    const key = await presignedUpload("/api/cut/library/presign", file, file.name, backend);
    const res = await backend.fetch("/api/cut/library/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, meta: { name: file.name, ...meta } }),
    });
    const body = await apiJson<LibraryAsset>(res);
    if (!res.ok) throw new Error(body.error ?? "Upload failed.");
    return { ...body, residency };
  }
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await backend.fetch("/api/cut/library", { method: "POST", body: form });
  const body = await apiJson<LibraryAsset>(res);
  if (!res.ok) throw new Error(body.error ?? "Upload failed.");
  return { ...body, residency };
}

export async function deleteFromLibrary(residency: Residency, id: string) {
  const res = await backendFor(residency).fetch(`/api/cut/library/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Could not delete.");
}

/** Land one library file in the open project and return its stored name.
 *
 * On the project's own shelf the server does the copy without the bytes ever
 * reaching the browser. Off it — a cloud project reaching for a clip on this
 * Mac, or the reverse — neither server can see the other, so the bytes come
 * down here and go back up into the project. */
async function copyLibraryFileToProject(
  projectId: string,
  residency: Residency,
  fileName: string,
  assetId?: string,
  opts?: { onProgress?: (fraction: number) => void; signal?: AbortSignal }
): Promise<string> {
  const target = getBackend();
  if (assetId && residency === target.kind) {
    const res = await target.fetch("/api/cut/library/use", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assetId, projectId }),
      signal: opts?.signal,
    });
    const body = await apiJson<{ fileName?: string }>(res);
    if (!res.ok || !body.fileName) throw new Error(body.error ?? "Could not add from library.");
    return body.fileName;
  }
  const bytes = await backendFor(residency).fetch(
    `/api/cut/library/media/${encodeURIComponent(fileName)}`,
    { signal: opts?.signal }
  );
  if (!bytes.ok) throw new Error("Could not read that library file.");
  return uploadProjectMediaTo(target, projectId, await bytes.blob(), fileName, opts);
}

/** Register a library asset in the open project's media, without placing it on
 * the timeline. Callers choose where it lands. Usable immediately: it plays
 * from the library's own route while the copy into the project runs behind
 * the editor (server-side on the asset's own shelf, download-and-upload
 * across residencies). */
export async function importLibraryAsset(
  projectId: string,
  lib: LibraryAsset
): Promise<MediaAsset> {
  return importRemote(
    projectId,
    {
      url: libraryMediaUrl(lib.fileName, lib.residency),
      name: lib.name,
      fileName: lib.fileName,
      type: lib.type,
      duration: lib.duration,
      width: lib.width,
      height: lib.height,
    },
    (opts) => copyLibraryFileToProject(projectId, lib.residency, lib.fileName, lib.id, opts)
  );
}

/** Copy a library asset into the open project and append it to the timeline. */
export async function addLibraryAssetToProject(
  projectId: string,
  lib: LibraryAsset
): Promise<MediaAsset> {
  const asset = await importLibraryAsset(projectId, lib);
  const s = useEditor.getState();
  if (asset.type === "video" || asset.type === "image") s.addClipFromAsset(asset.id);
  else s.addAudioFromAsset(asset.id);
  return asset;
}

/** Save the current timeline selection as a by-reference template. It lands on
 * the project's own shelf: the server copies the media straight across. */
export async function saveTemplate(
  projectId: string,
  input: TemplateSaveInput
): Promise<LibraryTemplateItem> {
  const residency = activeResidency();
  const res = await backendFor(residency).fetch("/api/cut/library/templates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, ...input }),
  });
  const body = await apiJson<LibraryTemplate>(res);
  if (!res.ok) throw new Error(body.error ?? "Could not save the template.");
  return { ...body, residency };
}

/** Append a project asset to a library template as one more part at its end:
 * the server copies the file into the library and returns the updated
 * template. Same-shelf only — the copy happens server-side, where neither
 * backend can see the other's project media. */
export async function addAssetToLibraryTemplate(
  projectId: string,
  template: LibraryTemplateItem,
  asset: MediaAsset
): Promise<LibraryTemplateItem> {
  if (template.residency !== getBackend().kind) {
    throw new Error(
      template.residency === "cloud"
        ? "That template is in the cloud; this project isn't."
        : "That template is on this Mac; this project isn't."
    );
  }
  const len = asset.type === "image" ? IMAGE_CLIP_SECONDS : asset.duration;
  const part =
    asset.type === "audio"
      ? { audio: { in: 0, out: len, volume: 1 } }
      : { layer: { in: 0, out: len, muted: false, track: 1, asClip: true } };
  const res = await getBackend().fetch(`/api/cut/library/templates/${template.id}/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      media: {
        fileName: asset.fileName,
        name: asset.name,
        type: asset.type,
        duration: asset.duration,
        width: asset.width,
        height: asset.height,
      },
      extend: len,
      ...part,
    }),
  });
  const body = await apiJson<LibraryTemplate>(res);
  if (!res.ok) throw new Error(body.error ?? "Could not add to the template.");
  return { ...body, residency: template.residency };
}

export async function renameTemplate(
  residency: Residency,
  id: string,
  name: string
): Promise<void> {
  const res = await backendFor(residency).fetch(`/api/cut/library/templates/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error("Could not rename the template.");
}

export async function deleteTemplate(residency: Residency, id: string): Promise<void> {
  const res = await backendFor(residency).fetch(`/api/cut/library/templates/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Could not delete the template.");
}

/** Land a template's media in the open project, in `template.media` order, and
 * return the stored file names. On the project's own shelf one call does the
 * whole copy server-side; off it each file rides through the browser. */
async function copyTemplateMediaToProject(
  projectId: string,
  template: LibraryTemplateItem
): Promise<TemplateMedia[]> {
  if (template.residency === getBackend().kind) {
    const res = await getBackend().fetch(`/api/cut/library/templates/${template.id}/use`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    const body = await apiJson<{ media?: TemplateMedia[] }>(res);
    if (!res.ok || !body.media) throw new Error(body.error ?? "Could not add the template.");
    return body.media;
  }
  const out: TemplateMedia[] = [];
  for (const m of template.media) {
    const fileName = await copyLibraryFileToProject(projectId, template.residency, m.fileName);
    out.push({ ...m, fileName });
  }
  return out;
}

/** Copy a template's media into the open project and re-materialize its clips,
 * overlays, and captions at the playhead — everything editable, nothing baked. */
export async function addTemplateToProject(
  projectId: string,
  template: LibraryTemplateItem,
  at?: number
): Promise<void> {
  const media = await copyTemplateMediaToProject(projectId, template);

  const s = useEditor.getState();
  // Each copied media file (in template.media order) becomes a project asset;
  // the layer/audio media indices resolve against this array. Enrichment gives
  // the new clips their filmstrip thumbnails and waveform peaks.
  const assetIds = media.map((m) => {
    const asset: MediaAsset = {
      id: crypto.randomUUID().slice(0, 8),
      fileName: m.fileName,
      name: m.name,
      type: m.type,
      duration: m.duration,
      width: m.width,
      height: m.height,
      url: mediaUrl(projectId, m.fileName),
    };
    s.addAsset(asset);
    void enrichAsset(asset);
    return asset.id;
  });
  s.insertTemplate(template, assetIds, at ?? playheadAt());
}

/** Copy a library template into the project as a project template: its media
 * land in the project's media folder and the template joins the Media panel.
 * Nothing is placed on the timeline. */
export async function importTemplateToProject(
  projectId: string,
  template: LibraryTemplateItem
): Promise<void> {
  const media = await copyTemplateMediaToProject(projectId, template);
  useEditor.getState().addTemplate({
    name: template.name,
    duration: template.duration,
    media,
    layers: template.layers,
    audio: template.audio,
    texts: template.texts,
    cues: template.cues,
  });
}

/** Materialize a project template onto the timeline at the playhead. Its media
 * already live in the project; assets are matched by file name and re-registered
 * if the Media entry was removed. */
export function addProjectTemplateToTimeline(
  projectId: string,
  template: LibraryTemplate,
  at?: number
) {
  const s = useEditor.getState();
  const assetIds = template.media.map((m) => {
    const existing = s.assets.find((a) => a.fileName === m.fileName);
    if (existing) return existing.id;
    const asset: MediaAsset = {
      id: crypto.randomUUID().slice(0, 8),
      fileName: m.fileName,
      name: m.name,
      type: m.type,
      duration: m.duration,
      width: m.width,
      height: m.height,
      url: mediaUrl(projectId, m.fileName),
    };
    s.addAsset(asset);
    void enrichAsset(asset);
    return asset.id;
  });
  useEditor.getState().insertTemplate(template, assetIds, at ?? playheadAt());
}

/** Copy a project asset into the shared library for reuse. It lands on the
 * project's own shelf, where the server can copy the bytes itself. */
export async function saveAssetToLibrary(
  projectId: string,
  asset: MediaAsset
): Promise<LibraryAsset> {
  const residency = activeResidency();
  const res = await backendFor(residency).fetch("/api/cut/library/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, fileName: asset.fileName, name: asset.name }),
  });
  const body = await apiJson<LibraryAsset>(res);
  if (!res.ok) throw new Error(body.error ?? "Could not save to library.");
  return { ...body, residency };
}
