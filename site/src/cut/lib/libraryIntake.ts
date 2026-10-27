"use client";

import { create } from "zustand";
import type { QueryClient } from "@tanstack/react-query";
import { currentEngineUser, subscribeEngineUser } from "@/cut/lib/api";
import { assetTypeOf, isMediaFile } from "@/cut/lib/media";
import { isFontArchive } from "@/cut/lib/fontArchive";
import { expandLinkedFiles, isLinkedFile, isLinkedType, linkedTypeOfFile, shelfForNewItem, syncLinkedLibrary } from "@/cut/lib/linkedLibrary";
import { readSnapshot, snapshotKey, writeSnapshot } from "@/cut/lib/cache";
import { estimatedShape, importUrlToLibrary, moveLibraryItem, uploadToLibrary, type ImportStage, type LibraryAsset } from "@/cut/lib/library";
import type { LibraryUploadState } from "@/cut/lib/libraryUpload";
import { libraryKey, libraryScope, patchLibrary, refetchLibrary } from "@/cut/lib/queries";
import type { Residency } from "@/cut/lib/residency";

export type LibraryArrival = {
  id: string;
  name: string;
  folderId: string | null;
  residency?: Residency;
  file?: File;
  source?: string;
  mediaType?: LibraryAsset["type"];
  startedAt: number;
  stage: "preparing" | "uploading" | ImportStage;
  startStage: "preparing" | "uploading" | ImportStage;
  shape?: { width: number; height: number };
  error?: string;
  run: () => Promise<void>;
};

export const useLibraryImports = create<{ items: LibraryArrival[] }>(() => ({ items: [] }));
const update = (fn: (items: LibraryArrival[]) => LibraryArrival[]) =>
  useLibraryImports.setState((state) => ({ items: fn(state.items) }));
export const dismissLibraryImport = (id: string) => {
  update((items) => items.filter((item) => item.id !== id));
  void editLinks(currentEngineUser(), (links) => links.filter((link) => link.id !== id));
};
/** The arriving picture's measured size, so its tile takes the shape the asset will. */
export const setLibraryImportShape = (id: string, shape: { width: number; height: number }) =>
  update((items) => items.map((item) => item.id === id ? { ...item, shape } : item));

// Navigation changes the view of these jobs; the files and retries belong to the account.
subscribeEngineUser(() => useLibraryImports.setState({ items: [] }));
let tail = Promise.resolve();
const accepts = (file: File) => isMediaFile(file) || isLinkedFile(file);

/** Publish the whole drop synchronously, then save it through the selected backend. */
export function importLibraryFiles(
  files: FileList | File[],
  target: { residency: Residency; folderId: string | null },
  client: QueryClient,
): Promise<void> {
  const owner = currentEngineUser();
  const wanted = (id: string) => currentEngineUser() === owner && useLibraryImports.getState().items.some((item) => item.id === id);
  const prepare = (file: File): LibraryArrival => {
    const id = crypto.randomUUID();
    const state: LibraryUploadState = {};
    let asset: LibraryAsset | undefined;
    let running: Promise<void> | undefined;
    const work = async () => {
      if (!wanted(id)) return;
      update((items) => items.map((item) => item.id === id ? { ...item, error: undefined, startedAt: Date.now() } : item));
      try {
        const expanded = await expandLinkedFiles([file]);
        if (!wanted(id)) return;
        if (expanded.length !== 1 || expanded[0] !== file) {
          const children = expanded.filter(accepts).map(prepare);
          if (!children.length) throw new Error("This archive contains no supported files.");
          update((items) => items.flatMap((item) => item.id === id ? children : [item]));
          for (const child of children) await child.run();
          return;
        }
        if (!accepts(file)) throw new Error("This file contains no supported media.");
        if (!asset) {
          const residency = isLinkedFile(file) && !target.folderId ? await shelfForNewItem(file.size) : target.residency;
          if (!wanted(id)) return;
          asset = await uploadToLibrary(file, residency, { state, folderId: residency === "cloud" ? target.folderId : undefined });
        }
        if (!wanted(id)) return;
        if (target.folderId && asset.folderId !== target.folderId) {
          await moveLibraryItem(asset.residency, asset.id, target.folderId);
          asset.folderId = target.folderId;
        }
        if (!wanted(id)) return;
        if (!client.getQueryData(libraryKey(libraryScope()))) {
          await refetchLibrary(client);
          if (!client.getQueryData(libraryKey(libraryScope()))) throw new Error("Could not refresh the library. Retry to show the saved file.");
        }
        const landed = asset;
        patchLibrary(client, (data) => ({ ...data, assets: [landed, ...data.assets.filter((item) => item.id !== landed.id)] }));
        if (isLinkedType(asset.type)) void syncLinkedLibrary();
        dismissLibraryImport(id);
      } catch (error) {
        if (wanted(id)) update((items) => items.map((item) => item.id === id ? { ...item, error: error instanceof Error ? error.message : "Could not import this file." } : item));
      }
    };
    return {
      id, name: file.name, file, ...target,
      mediaType: assetTypeOf(file) ?? linkedTypeOfFile(file) ?? undefined,
      stage: "queued", startStage: "queued", startedAt: Date.now(),
      run: () => running ??= work().finally(() => { running = undefined; }),
    };
  };
  const batch = Array.from(files).filter((file) => accepts(file) || isFontArchive(file)).map(prepare);
  update((items) => [...items, ...batch]);
  tail = tail.then(async () => { for (const item of batch) await item.run(); });
  return tail;
}

/** A link import as it is kept across reloads: enough to ask its shelf for the
 * same work again. It is stored while the work runs and dropped when it ends. */
type SavedLink = { id: string; url: string; residency: Residency; folderId: string | null; startedAt: number };

/** How long a saved link is worth resuming. An import still unsettled after
 * this has landed or failed on its own, and the listing shows which. */
const LINK_RESUME_MS = 30 * 60 * 1000;
const LINKS_SNAPSHOT = "library-links";

// Each account's saved links, read from disk once and edited in order after.
const savedLinks = new Map<string, Promise<SavedLink[]>>();
const linksOf = (owner: string | null) => {
  const key = snapshotKey("all", LINKS_SNAPSHOT);
  let links = savedLinks.get(key);
  if (!links) {
    links = readSnapshot<SavedLink[]>(key).then((hit) => hit?.value ?? []);
    savedLinks.set(key, links);
  }
  return owner === currentEngineUser() ? links : Promise.resolve(null);
};
let linkEdits = Promise.resolve();
function editLinks(owner: string | null, fn: (links: SavedLink[]) => SavedLink[]): Promise<void> {
  linkEdits = linkEdits.then(async () => {
    const links = await linksOf(owner);
    if (!links || owner !== currentEngineUser()) {
      return;
    }
    const next = fn(links);
    links.splice(0, links.length, ...next);
    writeSnapshot(snapshotKey("all", LINKS_SNAPSHOT), next);
  });
  return linkEdits;
}

/** Routing words a path spends on the way to the thing: they say nothing about
 * which post this is, so a label built from one ("youtube.com/watch") reads the
 * same for every import from that site. */
const ROUTE_SEGMENT = new Set(["watch", "video", "videos", "embed", "v", "e", "p", "post", "posts", "status", "share", "media", "download"]);

/** A link's name on its tile: the site it points at and the token that
 * identifies the post — the last telling path segment, or the id a watch URL
 * carries in its query — so two imports from one site read apart. */
function linkLabel(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const id = u.pathname.split("/").filter(Boolean).reverse().find((seg) => !ROUTE_SEGMENT.has(seg.toLowerCase())) ?? u.searchParams.get("v");
    return id ? `${host}/${id}` : host;
  } catch {
    return url;
  }
}

/** The tile for one link and the work behind it. The tile's id is the
 * import's key, so running it again — a retry, or a reload resuming it — gets
 * the job the shelf already has for it and the link lands once. */
function linkArrival(saved: SavedLink, client: QueryClient): LibraryArrival {
  const owner = currentEngineUser();
  const { id, url, residency, folderId } = saved;
  let link = saved;
  const wanted = () => currentEngineUser() === owner && useLibraryImports.getState().items.some((item) => item.id === id);
  let running: Promise<void> | undefined;
  const work = async () => {
    // A retry restarts the clock on the tile and on the saved link.
    if (useLibraryImports.getState().items.find((item) => item.id === id)?.error) {
      link = { ...link, startedAt: Date.now() };
      update((items) => items.map((item) => item.id === id ? { ...item, error: undefined, stage: item.startStage, startedAt: link.startedAt } : item));
    }
    await editLinks(owner, (links) => [...links.filter((l) => l.id !== id), link]);
    try {
      const imported = await importUrlToLibrary(url, residency, (stage) => {
        if (wanted()) update((items) => items.map((item) => item.id === id ? { ...item, stage } : item));
      }, id);
      if (folderId) {
        for (const asset of imported) {
          await moveLibraryItem(residency, asset.id, folderId).catch(() => {});
          asset.folderId = folderId;
        }
      }

      // The listing may have read the asset already: it replaces that copy.
      if (currentEngineUser() === owner) {
        const ids = new Set(imported.map((asset) => asset.id));
        patchLibrary(client, (data) => ({ ...data, assets: [...imported, ...data.assets.filter((asset) => !ids.has(asset.id))] }));
      }
      dismissLibraryImport(id);
    } catch (error) {
      if (wanted()) update((items) => items.map((item) => item.id === id ? { ...item, error: error instanceof Error ? error.message : "Could not import that URL." } : item));
      await editLinks(owner, (links) => links.filter((l) => l.id !== id));
    }
  };
  return {
    id, name: linkLabel(url), folderId, residency, source: url,
    stage: "queued", startStage: "queued", startedAt: saved.startedAt,
    shape: estimatedShape(url),
    run: () => running ??= work().finally(() => { running = undefined; }),
  };
}

/** Import a link into a shelf: its tile goes up at once and stays until the
 * asset takes its place, across reloads. */
export function importLibraryLink(
  url: string,
  target: { residency: Residency; folderId: string | null },
  client: QueryClient,
): Promise<void> {
  const item = linkArrival({ id: crypto.randomUUID(), url, ...target, startedAt: Date.now() }, client);
  update((items) => [...items, item]);
  return item.run();
}

/** Put back the tiles of link imports a reload cut off and pick their work up
 * again. Only publishes them; each one's work runs on. */
export async function resumeLibraryLinks(client: QueryClient): Promise<void> {
  const owner = currentEngineUser();
  const links = await linksOf(owner);
  if (!links) {
    return;
  }

  // Links past the resume window are dropped; the listing shows how they ended.
  const fresh = links.filter((link) => Date.now() - link.startedAt < LINK_RESUME_MS);
  if (fresh.length < links.length) {
    void editLinks(owner, (all) => all.filter((link) => fresh.includes(link)));
  }
  const shown = new Set(useLibraryImports.getState().items.map((item) => item.id));
  const back = fresh.filter((link) => !shown.has(link.id)).map((link) => linkArrival(link, client));
  if (back.length === 0) {
    return;
  }
  update((items) => [...items, ...back]);
  for (const item of back) {
    void item.run();
  }
}
