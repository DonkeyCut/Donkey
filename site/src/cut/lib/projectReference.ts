// Reading another Donkey Cut project as a reference for the assistant: its
// document, and the bytes of any of its media a copy needs. A project of the
// user's own is reached through whichever home holds it; a share link
// through the share's own read-only surface. Reads only — nothing here
// touches the reference.
//
// A headless engine holds its projects on disk, so it installs a host store
// and this module reads the folder directly; a cloud or shared reference
// needs the editor page's sign-in there and is refused with a plain reason.

import { getBackend, type CutBackend } from "./backend";
import { sharedBackendFor } from "./backend/shared";
import { apiJson } from "./api";
import { tagChatAsset } from "./chatAssets";
import { registerFontAsset } from "./fontAssets";
import { enrichAsset, uploadProjectMediaTo } from "./media";
import { localMediaFile, storedMediaUrl } from "./mediaSync";
import type { ProjectLink } from "./projectLink";
import { projectBackend } from "./residency";
import { useEditor } from "./store";
import type { MediaAsset, ProjectDoc, ShareFeatures, StoredAsset } from "./types";

/** What a headless host does for itself: read a project it stores, copy a
 * media file between two of its projects. */
export interface HostDocStore {
  readDoc(projectId: string): Promise<ProjectDoc | null>;
  copyMedia(srcProjectId: string, fileName: string, dstProjectId: string): Promise<string>;
}

let host: HostDocStore | null = null;

export function setHostDocStore(store: HostDocStore | null) {
  host = store;
}

export type ReferenceResidency = "local" | "cloud" | "browser" | "shared";

export interface ReferenceProject {
  link: ProjectLink;
  projectId: string;
  doc: ProjectDoc;
  residency: ReferenceResidency;
  /** The backend the reference reads through; null when the host store
   * answered from disk. */
  backend: CutBackend | null;
  /** What a share withheld from the document, in the reader's words. */
  partial: string[];
}

const BROWSER_ONLY =
  "A project kept in a browser's own storage is readable only from that browser.";

export async function openReference(link: ProjectLink): Promise<ReferenceProject> {
  if (link.kind === "share") return openShare(link.token, link);
  const id = link.id;
  if (host) {
    const doc = await host.readDoc(id);
    if (!doc)
      throw new Error(
        `No project with id ${id} on this Mac. Reading a cloud or shared project needs the editor page's sign-in; open the chat in the editor to read it.`
      );
    return { link, projectId: id, doc, residency: "local", backend: null, partial: [] };
  }
  const backend = await projectBackend(id);
  const res = await backend.fetch(`/api/cut/projects/${encodeURIComponent(id)}`);
  if (res.status === 404)
    throw new Error(`No project with id ${id} that this account can open. ${BROWSER_ONLY}`);
  if (!res.ok) throw new Error(`Could not read project ${id} (${res.status}).`);
  const doc = (await res.json()) as ProjectDoc;
  const residency: ReferenceResidency =
    backend.kind === "local" || backend.kind === "browser" ? backend.kind : "cloud";
  return { link, projectId: id, doc, residency, backend, partial: [] };
}

async function openShare(token: string, link: ProjectLink): Promise<ReferenceProject> {
  if (host)
    throw new Error(
      "Reading a shared project needs the editor page's sign-in; open the chat in the editor to read it."
    );
  const backend = sharedBackendFor(token);
  const meta = await backend.fetch("/api/cut/");
  if (meta.status === 401) throw new Error("Sign in to open that share.");
  if (meta.status === 403) throw new Error("This account was not invited to that share.");
  if (meta.status === 404) throw new Error("That share link does not exist.");
  if (!meta.ok) throw new Error(`Could not open that share (${meta.status}).`);
  const info = await apiJson<{ projectId?: string; features?: ShareFeatures }>(meta);
  if (!info.projectId) throw new Error(info.error ?? "Could not open that share.");
  const res = await backend.fetch(`/api/cut/projects/${encodeURIComponent(info.projectId)}`);
  if (!res.ok) throw new Error(`Could not read the shared project (${res.status}).`);
  const doc = (await res.json()) as ProjectDoc;
  const partial: string[] = [];
  const f = info.features;
  if (f && !f.subtitles) partial.push("the caption track and caption look");
  if (f && !f.media) partial.push("media the timeline does not use");
  if (f && !f.genai) partial.push("generated media the timeline does not use");
  return { link, projectId: info.projectId, doc, residency: "shared", backend, partial };
}

/** Where this page can play a reference's file from. The share surface
 * answers its media route with a signed redirect the decoders follow. */
export async function referenceMediaUrl(ref: ReferenceProject, fileName: string): Promise<string> {
  const path = `/api/cut/projects/${encodeURIComponent(ref.projectId)}/media/${encodeURIComponent(fileName)}`;
  if (!ref.backend) return getBackend().url(path);
  if (ref.backend.kind === "shared") return ref.backend.url(path);
  return storedMediaUrl(ref.projectId, fileName, ref.backend);
}

/** One reference file's bytes, read the way a project copy reads them. */
async function referenceMediaBlob(ref: ReferenceProject, asset: StoredAsset): Promise<Blob> {
  if (!ref.backend) throw new Error("No transport for the reference's media.");
  const local = ref.backend.kind === "cloud" ? await localMediaFile(ref.projectId, asset.fileName) : null;
  if (local) return local;
  const res = await ref.backend.fetch(
    `/api/cut/projects/${encodeURIComponent(ref.projectId)}/media/${encodeURIComponent(asset.fileName)}`
  );
  if (!res.ok) throw new Error(`Could not read “${asset.name}” from the reference.`);
  return res.blob();
}

/** Copy reference files into a project, one by one; each lands under the
 * name the target hands back. */
export async function copyReferenceMedia(
  ref: ReferenceProject,
  assets: StoredAsset[],
  dstProjectId: string,
  dstBackend: CutBackend = getBackend()
): Promise<{ source: StoredAsset; fileName: string }[]> {
  const out: { source: StoredAsset; fileName: string }[] = [];
  for (const source of assets) {
    const fileName = host
      ? await host.copyMedia(ref.projectId, source.fileName, dstProjectId)
      : await uploadProjectMediaTo(dstBackend, dstProjectId, await referenceMediaBlob(ref, source), source.fileName);
    out.push({ source, fileName });
  }
  return out;
}

/** A reference asset as it stands in the open project after a copy. */
export interface LandedAsset {
  sourceId: string;
  asset: MediaAsset;
  /** The project already held a copy of this source, so nothing was copied. */
  reused: boolean;
}

/**
 * Reference files copied into the open project and registered as its assets.
 * The notes, transcript and beat grid written against the source ride along,
 * a font installs so titles set in it draw, and each copy remembers where it
 * came from, so the same source pasted or replicated twice lands once. A
 * chat's copies preview on its cards; a keyboard paste is the user's own
 * import.
 */
export async function landReferenceAssets(
  ref: ReferenceProject,
  sources: StoredAsset[],
  projectId: string,
  opts: { chatId?: string | null } = {}
): Promise<LandedAsset[]> {
  const out: LandedAsset[] = [];
  const toCopy: StoredAsset[] = [];
  for (const source of sources) {
    const have = useEditor
      .getState()
      .assets.find((a) => a.copiedFrom?.projectId === ref.projectId && a.copiedFrom.assetId === source.id);
    if (have) out.push({ sourceId: source.id, asset: have, reused: true });
    else toCopy.push(source);
  }
  const copied = await copyReferenceMedia(ref, toCopy, projectId);
  for (const { source, fileName } of copied) {
    // The copy is this project's: a fresh id, no chat or folder of the
    // reference's, and the card the asking chat tags below.
    const asset: MediaAsset = {
      ...source,
      id: crypto.randomUUID().slice(0, 8),
      fileName,
      url: await storedMediaUrl(projectId, fileName),
      copiedFrom: { projectId: ref.projectId, assetId: source.id },
    };
    delete asset.chatId;
    delete asset.folderId;
    // A keyboard paste is the user's own import, so the copy lists in the
    // Media panel like one; a sticker stays a sticker. A chat's copy keeps
    // the source's origin under the chat tag below.
    if (opts.chatId === undefined && asset.origin !== "sticker") delete asset.origin;
    // The bytes landed in `projectId`; the record lands only if that project
    // is still the open one.
    if (useEditor.getState().projectId !== projectId)
      throw new Error("The project closed while its media was landing.");
    useEditor.getState().addAsset(asset);
    if (opts.chatId !== undefined) tagChatAsset(asset.id, opts.chatId);
    if (asset.type === "font") void registerFontAsset(asset).catch(() => {});
    else void enrichAsset(asset).catch(() => {});
    out.push({ sourceId: source.id, asset, reused: false });
  }
  // In the order asked for, so a caller's index arithmetic holds.
  const bySource = new Map(out.map((l) => [l.sourceId, l]));
  return sources.map((s) => bySource.get(s.id)!);
}
