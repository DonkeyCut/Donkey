"use client";

import { apiJson, getBackend } from "./backend";
import { cloudBackend } from "./backend/cloud";
import { readSnapshot, writeSnapshot } from "./cache";
import { pollCloudJob } from "./cloudJob";
import { downloadFromUrl } from "./download";
import { normalizeLink } from "./link";
import { installFontFace } from "./fontAssets";
import { fontLabelFor } from "./fontName";
import { specimenPng } from "./fontSpecimen";
import {
  enrichAsset,
  importRemote,
  isFontFile,
  MAX_FONT_BYTES,
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
import type {
  LibraryTemplate,
  MediaAsset,
  TemplateMedia,
  TemplateSaveInput,
} from "./types";
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
  type: "video" | "audio" | "image" | "font";
  duration: number;
  width?: number;
  height?: number;
  addedAt: number;
  folderId?: string | null;
  source?: LibrarySource;
  /** The source's own cover image, stored beside the media on the same shelf.
   * An import from a site that publishes one carries it; it is what a card and
   * the viewer show while the video itself loads. */
  posterFile?: string;
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
  backendFor(residency).url(
    `/api/cut/library/media/${encodeURIComponent(fileName)}`,
  );

/** The asset's cover image, when the import brought one back. */
export const libraryPosterUrl = (
  a: Pick<LibraryAsset, "posterFile" | "residency">,
) => (a.posterFile ? libraryMediaUrl(a.posterFile, a.residency) : undefined);

/** Save a library file to the user's Downloads folder, off the shelf it sits
 * on. */
export function downloadLibraryAsset(
  a: Pick<LibraryAsset, "fileName" | "residency">,
) {
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
async function rememberedLibraryFrom(
  r: Residency,
): Promise<LibraryData | null> {
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
export async function fetchLibrary(opts?: {
  remembered?: boolean;
}): Promise<LibraryData> {
  const live = availableResidencies();
  const rs = opts?.remembered ? listedResidencies() : live;
  const parts = await Promise.all(
    rs.map((r) =>
      live.includes(r)
        ? fetchLibraryFrom(r).catch(() => null)
        : rememberedLibraryFrom(r),
    ),
  );
  const got = parts.filter((p): p is LibraryData => p !== null);
  if (got.length === 0) throw new Error("Could not load the library.");
  const byNewest = <T extends { addedAt: number }>(items: T[]) =>
    [...items].sort((a, b) => b.addedAt - a.addedAt);
  return {
    assets: byNewest(got.flatMap((p) => p.assets)),
    folders: got
      .flatMap((p) => p.folders)
      .sort((a, b) => a.createdAt - b.createdAt),
    templates: byNewest(got.flatMap((p) => p.templates)),
  };
}

/** Where an import is in its trip: waiting for a worker, pulling the media
 * down, or writing it onto the shelf. The library shows it on the tile the
 * import already took. */
export type ImportStage = "queued" | "downloading" | "saving";

/** The shape a link is likely to land in, before anything is known about it:
 * the short-form feeds are vertical, everything else is filmed wide. The tile
 * takes the real shape the moment the media lands. */
export function estimatedShape(url: string): { width: number; height: number } {
  return SHORT_FORM_URL.test(url)
    ? { width: 9, height: 16 }
    : { width: 16, height: 9 };
}

const SHORT_FORM_URL =
  /^https?:\/\/[^/]*(?:youtube\.com\/shorts\/|tiktok\.com\/|instagram\.com\/(?:reels?|stories)\/)/i;

export async function importUrlToLibrary(
  url: string,
  residency: Residency = activeResidency(),
  onStage?: (stage: ImportStage) => void,
): Promise<LibraryAsset[]> {
  url = normalizeLink(url);
  if (residency === "browser")
    return importUrlThroughCloud(url, "browser", onStage);
  onStage?.("downloading");
  const backend = backendFor(residency);
  const res = await backend.fetch("/api/cut/library/import-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  // The engine downloads inside the request; the cloud answers {jobId} and a
  // worker does the fetch, so that side waits on the job.
  if (backend.kind === "cloud") {
    const started = await apiJson<{ jobId?: string }>(res);
    if (!res.ok || !started.jobId)
      throw new Error(started.error ?? "Could not import that URL.");
    const done = await pollCloudJob<{ assets?: LibraryAsset[] }>(
      started.jobId,
      backend,
      "Could not import that URL.",
      {
        onState: (state) =>
          onStage?.(state === "queued" ? "queued" : "downloading"),
      },
    );
    // The library holds media, so a source that turned out to be only words
    // fails here — the same line the engine's library import draws.
    if (!done.assets?.length)
      throw new Error("That link has no media to import.");
    return done.assets.map((a) => ({ ...a, residency }));
  }
  const body = await apiJson<LibraryAsset[]>(res);
  if (res.ok)
    return (Array.isArray(body) ? body : []).map((a) => ({ ...a, residency }));
  // The engine fetches with the tools it ships, and a site can refuse the
  // build it happens to carry — TikTok reads the requests it impersonates with
  // and answers with nothing usable. The cloud worker fetches with a different
  // one, so the link gets a second chance there and the bytes come back down
  // to this Mac. The engine's own reason stands if that side can't do it
  // either: it is the shelf the user was importing to.
  const reason = body.error ?? "Could not import that URL.";
  try {
    return await importUrlThroughCloud(url, residency, onStage);
  } catch {
    throw new Error(reason);
  }
}

/**
 * A link fetched by the cloud worker and landed on a shelf of this machine.
 *
 * Nothing in a page can pull a video off a YouTube or TikTok link, so the
 * browser shelf always imports this way; the engine falls back to it when the
 * fetch it runs itself comes back empty-handed. The worker stages the media in
 * the account's cloud shelf, where this browser can read it, and the bytes come
 * straight back down into the target shelf's own storage. The staged cloud copy
 * is dropped once they land, however this ends, so an import leaves nothing
 * behind on a shelf the user wasn't importing to.
 */
async function importUrlThroughCloud(
  url: string,
  target: Residency,
  onStage?: (stage: ImportStage) => void,
): Promise<LibraryAsset[]> {
  onStage?.("downloading");
  const res = await cloudBackend.fetch("/api/cut/library/import-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const started = await apiJson<{ jobId?: string }>(res);
  if (!res.ok || !started.jobId)
    throw new Error(started.error ?? "Could not import that URL.");
  const done = await pollCloudJob<{ assets?: LibraryAsset[] }>(
    started.jobId,
    cloudBackend,
    "Could not import that URL.",
    {
      onState: (state) =>
        onStage?.(state === "queued" ? "queued" : "downloading"),
    },
  );
  // The library holds media, so a source that turned out to be only words
  // fails here — the same line the engine's library import draws.
  if (!done.assets?.length)
    throw new Error("That link has no media to import.");
  const landed: LibraryAsset[] = [];
  onStage?.("saving");
  try {
    for (const staged of done.assets) {
      const bytes = await cloudBackend.fetch(
        `/api/cut/library/media/${encodeURIComponent(staged.fileName)}`,
      );
      if (!bytes.ok) throw new Error("Could not import that URL.");
      const form = new FormData();
      form.append("file", await bytes.blob(), staged.fileName);
      form.append("name", staged.name);
      if (staged.posterFile) {
        const poster = await cloudBackend.fetch(
          `/api/cut/library/media/${encodeURIComponent(staged.posterFile)}`,
        );
        if (poster.ok)
          form.append("poster", await poster.blob(), staged.posterFile);
      }
      form.append(
        "meta",
        JSON.stringify({
          type: staged.type,
          duration: staged.duration,
          width: staged.width,
          height: staged.height,
        }),
      );
      if (staged.source) form.append("source", JSON.stringify(staged.source));
      const saved = await backendFor(target).fetch("/api/cut/library", {
        method: "POST",
        body: form,
      });
      const body = await apiJson<LibraryAsset>(saved);
      if (!saved.ok)
        throw new Error(body.error ?? "Could not import that URL.");
      landed.push({ ...body, residency: target });
    }
  } catch (e) {
    // A part-written import is worse than none: the user reads an error and is
    // left holding half a link.
    for (const a of landed)
      await deleteFromLibrary(target, a.id).catch(() => {});
    throw e;
  } finally {
    for (const staged of done.assets) {
      await cloudBackend
        .fetch(`/api/cut/library/${staged.id}`, { method: "DELETE" })
        .catch(() => {});
    }
  }
  return landed;
}

export async function createLibraryFolder(
  name: string,
  residency: Residency = activeResidency(),
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
  name: string,
): Promise<void> {
  const res = await backendFor(residency).fetch(
    `/api/cut/library/folders/${id}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );
  if (!res.ok) throw new Error("Could not rename folder.");
}

export async function deleteLibraryFolder(
  residency: Residency,
  id: string,
): Promise<void> {
  const res = await backendFor(residency).fetch(
    `/api/cut/library/folders/${id}`,
    {
      method: "DELETE",
    },
  );
  if (!res.ok) throw new Error("Could not delete folder.");
}

/** File a library item — an asset or a template — into a folder on its own
 * shelf (`null` ungroups). Folders don't span residencies: a cloud item can't
 * move into a folder that lives on the Mac. */
export async function moveLibraryItem(
  residency: Residency,
  id: string,
  folderId: string | null,
): Promise<void> {
  const res = await backendFor(residency).fetch("/api/cut/library/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, folderId }),
  });
  if (!res.ok) throw new Error("Could not move item.");
}

/**
 * Carry a library file to another shelf, filed where it lands.
 *
 * A folder belongs to one shelf, so filing an item into one can mean crossing
 * shelves. Neither server can see the other, so the bytes come down here and go
 * back up, the item keeps its name and the link it was imported from, and the
 * copy left behind comes off.
 */
export async function carryAssetTo(
  asset: LibraryAsset,
  to: Residency,
  folderId: string | null,
): Promise<LibraryAsset> {
  const res = await backendFor(asset.residency).fetch(
    `/api/cut/library/media/${encodeURIComponent(asset.fileName)}`,
  );
  if (!res.ok) throw new Error("Could not read that file off its shelf.");
  const from = libraryPosterUrl(asset);
  const cover = from
    ? await backendFor(asset.residency)
        .fetch(
          `/api/cut/library/media/${encodeURIComponent(asset.posterFile!)}`,
        )
        .then((r) => (r.ok ? r.blob() : null))
        .catch(() => null)
    : null;
  const landed = await uploadToLibrary(
    new File([await res.blob()], asset.fileName),
    to,
    {
      name: asset.name,
      ...(asset.source ? { source: asset.source } : {}),
      ...(cover ? { poster: cover } : {}),
    },
  );
  if (folderId) await moveLibraryItem(to, landed.id, folderId).catch(() => {});
  await deleteFromLibrary(asset.residency, asset.id).catch(() => {});
  return { ...landed, folderId };
}

/** A font is readable when the renderer can install it, so the check runs
 * through the installer seam: the file that passes here is exactly the file a
 * preview and a render job can draw with, and a renamed archive or a truncated
 * download is refused before a byte leaves the browser. It comes back with the
 * family name the font calls itself — the shelf's label and the font menu's —
 * and a specimen drawn in the face it just installed, which becomes the file's
 * cover, so a card never has to have the font installed to show it. */
async function checkFont(
  file: File,
): Promise<{ label: string; poster: Blob | null }> {
  if (file.size > MAX_FONT_BYTES) {
    throw new Error(
      `Fonts are limited to ${Math.round(MAX_FONT_BYTES / 1024 ** 2)}MB.`,
    );
  }
  const bytes = await file.arrayBuffer();
  const family = `lf-check-${file.size}`;
  try {
    await installFontFace(family, bytes);
  } catch {
    throw new Error("That file isn't a font Cut can read.");
  }
  return {
    label: fontLabelFor(bytes, file.name),
    poster: await specimenPng(family).catch(() => null),
  };
}

export async function uploadToLibrary(
  file: File,
  residency: Residency = activeResidency(),
  /** What the shelf should call it and where it came from, when the file is
   * arriving from somewhere that already knows — a carry from another shelf,
   * say. Left out, the file names itself and keeps whatever cover it makes. */
  keep: { name?: string; source?: LibrarySource; poster?: Blob } = {},
): Promise<LibraryAsset> {
  const backend = backendFor(residency);
  // A font has no streams to measure; it is checked by installing it instead,
  // and the check hands back the specimen the shelf keeps as its cover.
  const font = isFontFile(file) ? await checkFont(file) : null;
  const fontLabel = font?.label ?? null;
  const poster = keep.poster ?? font?.poster ?? null;
  const posterName = `${file.name}.specimen.png`;
  const fontMeta = { type: "font" as const, duration: 0 };
  if (residency === "cloud") {
    // Presign -> direct R2 PUT -> complete, with the media probed here — the
    // cloud can't cheaply probe an R2 object the way the engine probes disk.
    // A file this browser can't decode would land as a zero-length asset it
    // also couldn't preview, so reject it before any bytes go up.
    const meta = fontLabel
      ? fontMeta
      : await probeFileMeta(file).catch(() => null);
    if (
      !meta ||
      (meta.type !== "image" && meta.type !== "font" && !(meta.duration > 0))
    ) {
      throw new Error(
        "This file can't be read in this browser, so it can't go in the cloud library. Import it in the Mac app instead.",
      );
    }
    const key = await presignedUpload(
      "/api/cut/library/presign",
      file,
      file.name,
      backend,
    );
    // The cover rides up as an object of its own; `complete` marks it and
    // records it against the asset.
    const posterKey = poster
      ? await presignedUpload(
          "/api/cut/library/presign",
          poster,
          posterName,
          backend,
        ).catch(() => null)
      : null;
    const res = await backend.fetch("/api/cut/library/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key,
        ...(posterKey ? { posterKey } : {}),
        meta: {
          name: keep.name ?? fontLabel ?? file.name,
          ...(keep.source ? { source: keep.source } : {}),
          ...meta,
        },
      }),
    });
    const body = await apiJson<LibraryAsset>(res);
    if (!res.ok) throw new Error(body.error ?? "Upload failed.");
    return { ...body, residency };
  }
  const form = new FormData();
  form.append("file", file, file.name);
  const name = keep.name ?? fontLabel;
  if (name) form.append("name", name);
  if (keep.source) form.append("source", JSON.stringify(keep.source));
  if (poster) form.append("poster", poster, posterName);
  if (residency === "browser") {
    // The shelf is this page's storage, with no ffprobe behind it: the file is
    // measured here, and one this browser can't read is refused rather than
    // shelved as an asset nothing can play.
    const meta = fontLabel
      ? fontMeta
      : await probeFileMeta(file).catch(() => null);
    if (
      !meta ||
      (meta.type !== "image" && meta.type !== "font" && !(meta.duration > 0))
    ) {
      throw new Error(
        "This file can't be read in this browser, so it can't go in the library.",
      );
    }
    form.append("meta", JSON.stringify(meta));
  }
  const res = await backend.fetch("/api/cut/library", {
    method: "POST",
    body: form,
  });
  const body = await apiJson<LibraryAsset>(res);
  if (!res.ok) throw new Error(body.error ?? "Upload failed.");
  return { ...body, residency };
}

export async function deleteFromLibrary(residency: Residency, id: string) {
  const res = await backendFor(residency).fetch(`/api/cut/library/${id}`, {
    method: "DELETE",
  });
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
  opts?: { onProgress?: (fraction: number) => void; signal?: AbortSignal },
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
    if (!res.ok || !body.fileName)
      throw new Error(body.error ?? "Could not add from library.");
    return body.fileName;
  }
  const bytes = await backendFor(residency).fetch(
    `/api/cut/library/media/${encodeURIComponent(fileName)}`,
    { signal: opts?.signal },
  );
  if (!bytes.ok) throw new Error("Could not read that library file.");
  return uploadProjectMediaTo(
    target,
    projectId,
    await bytes.blob(),
    fileName,
    opts,
  );
}

/** Register a library asset in the open project's media, without placing it on
 * the timeline. Callers choose where it lands. Usable immediately: it plays
 * from the library's own route while the copy into the project runs behind
 * the editor (server-side on the asset's own shelf, download-and-upload
 * across residencies). */
export async function importLibraryAsset(
  projectId: string,
  lib: LibraryAsset,
): Promise<MediaAsset> {
  if (lib.type === "font")
    throw new Error("Fonts are used from the font menu, not the timeline.");
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
    (opts) =>
      copyLibraryFileToProject(
        projectId,
        lib.residency,
        lib.fileName,
        lib.id,
        opts,
      ),
  );
}

/** Copy a library asset into the open project and add it to the timeline at
 * the playhead. */
export async function addLibraryAssetToProject(
  projectId: string,
  lib: LibraryAsset,
): Promise<MediaAsset> {
  const asset = await importLibraryAsset(projectId, lib);
  useEditor.getState().addAssetAtPlayhead(asset.id);
  return asset;
}

/** Save the current timeline selection as a by-reference template. It lands on
 * the project's own shelf: the server copies the media straight across. */
export async function saveTemplate(
  projectId: string,
  input: TemplateSaveInput,
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

/**
 * Carry a template to another shelf, filed where it lands.
 *
 * A template's media live privately in the library, so the carry takes them
 * with it: the files come down here and go up on the target shelf — presigned
 * objects in the cloud, a multipart post anywhere else — and the doc arrives in
 * the same order, since `layers` and `audio` point at `media` by index. The
 * template left behind comes off.
 */
export async function carryTemplateTo(
  t: LibraryTemplateItem,
  to: Residency,
  folderId: string | null,
): Promise<void> {
  const source = backendFor(t.residency);
  const files: File[] = [];
  for (const m of t.media) {
    const res = await source.fetch(
      `/api/cut/library/media/${encodeURIComponent(m.fileName)}`,
    );
    if (!res.ok)
      throw new Error("Could not read that template's media off its shelf.");
    files.push(new File([await res.blob()], m.fileName));
  }
  const input = {
    name: t.name,
    folderId,
    duration: t.duration,
    media: t.media,
    layers: t.layers,
    audio: t.audio,
    texts: t.texts,
    cues: t.cues,
  };
  const backend = backendFor(to);
  let res: Response;
  if (to === "cloud") {
    const keys: string[] = [];
    for (const f of files) {
      keys.push(
        await presignedUpload("/api/cut/library/presign", f, f.name, backend),
      );
    }
    res = await backend.fetch("/api/cut/library/templates/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, keys }),
    });
  } else {
    const form = new FormData();
    form.append("doc", JSON.stringify(input));
    for (const f of files) form.append("file", f, f.name);
    res = await backend.fetch("/api/cut/library/templates/import", {
      method: "POST",
      body: form,
    });
  }
  const body = await apiJson<LibraryTemplate>(res);
  if (!res.ok) throw new Error(body.error ?? "Could not add the template.");
  await deleteTemplate(t.residency, t.id);
}

/** Append a project asset to a library template as one more part at its end:
 * the server copies the file into the library and returns the updated
 * template. Same-shelf only — the copy happens server-side, where neither
 * backend can see the other's project media. */
export async function addAssetToLibraryTemplate(
  projectId: string,
  template: LibraryTemplateItem,
  asset: MediaAsset,
): Promise<LibraryTemplateItem> {
  if (template.residency !== getBackend().kind) {
    throw new Error(
      template.residency === "cloud"
        ? "That template is in the cloud; this project isn't."
        : "That template is on this Mac; this project isn't.",
    );
  }
  const len = asset.type === "image" ? IMAGE_CLIP_SECONDS : asset.duration;
  const part =
    asset.type === "audio"
      ? { audio: { in: 0, out: len, volume: 1 } }
      : { layer: { in: 0, out: len, muted: false, track: 1, asClip: true } };
  const res = await getBackend().fetch(
    `/api/cut/library/templates/${template.id}/add`,
    {
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
    },
  );
  const body = await apiJson<LibraryTemplate>(res);
  if (!res.ok) throw new Error(body.error ?? "Could not add to the template.");
  return { ...body, residency: template.residency };
}

export async function renameTemplate(
  residency: Residency,
  id: string,
  name: string,
): Promise<void> {
  const res = await backendFor(residency).fetch(
    `/api/cut/library/templates/${id}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );
  if (!res.ok) throw new Error("Could not rename the template.");
}

export async function deleteTemplate(
  residency: Residency,
  id: string,
): Promise<void> {
  const res = await backendFor(residency).fetch(
    `/api/cut/library/templates/${id}`,
    {
      method: "DELETE",
    },
  );
  if (!res.ok) throw new Error("Could not delete the template.");
}

/** Land a template's media in the open project, in `template.media` order, and
 * return the stored file names. On the project's own shelf one call does the
 * whole copy server-side; off it each file rides through the browser. */
async function copyTemplateMediaToProject(
  projectId: string,
  template: LibraryTemplateItem,
): Promise<TemplateMedia[]> {
  if (template.residency === getBackend().kind) {
    const res = await getBackend().fetch(
      `/api/cut/library/templates/${template.id}/use`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      },
    );
    const body = await apiJson<{ media?: TemplateMedia[] }>(res);
    if (!res.ok || !body.media)
      throw new Error(body.error ?? "Could not add the template.");
    return body.media;
  }
  const out: TemplateMedia[] = [];
  for (const m of template.media) {
    const fileName = await copyLibraryFileToProject(
      projectId,
      template.residency,
      m.fileName,
    );
    out.push({ ...m, fileName });
  }
  return out;
}

/** Copy a template's media into the open project and re-materialize its clips,
 * overlays, and captions at the playhead — everything editable, nothing baked. */
export async function addTemplateToProject(
  projectId: string,
  template: LibraryTemplateItem,
  at?: number,
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
  template: LibraryTemplateItem,
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
  at?: number,
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
  asset: MediaAsset,
): Promise<LibraryAsset> {
  const residency = activeResidency();
  const res = await backendFor(residency).fetch("/api/cut/library/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      fileName: asset.fileName,
      name: asset.name,
    }),
  });
  const body = await apiJson<LibraryAsset>(res);
  if (!res.ok) throw new Error(body.error ?? "Could not save to library.");
  return { ...body, residency };
}
