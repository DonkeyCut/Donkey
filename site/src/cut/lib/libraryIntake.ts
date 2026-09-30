"use client";

import { create } from "zustand";
import type { QueryClient } from "@tanstack/react-query";
import { currentEngineUser, subscribeEngineUser } from "@/cut/lib/api";
import { assetTypeOf, isMediaFile } from "@/cut/lib/media";
import { isFontArchive } from "@/cut/lib/fontArchive";
import { expandLinkedFiles, isLinkedFile, isLinkedType, linkedTypeOfFile, shelfForNewItem, syncLinkedLibrary } from "@/cut/lib/linkedLibrary";
import { moveLibraryItem, uploadToLibrary, type ImportStage, type LibraryAsset } from "@/cut/lib/library";
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

export const useLibraryFileImports = create<{ items: LibraryArrival[] }>(() => ({ items: [] }));
const update = (fn: (items: LibraryArrival[]) => LibraryArrival[]) =>
  useLibraryFileImports.setState((state) => ({ items: fn(state.items) }));
export const dismissLibraryImport = (id: string) => update((items) => items.filter((item) => item.id !== id));
/** The arriving picture's measured size, so its tile takes the shape the asset will. */
export const setLibraryImportShape = (id: string, shape: { width: number; height: number }) =>
  update((items) => items.map((item) => item.id === id ? { ...item, shape } : item));

// Navigation changes the view of these jobs; the files and retries belong to the account.
subscribeEngineUser(() => useLibraryFileImports.setState({ items: [] }));
let tail = Promise.resolve();
const accepts = (file: File) => isMediaFile(file) || isLinkedFile(file);

/** Publish the whole drop synchronously, then save it through the selected backend. */
export function importLibraryFiles(
  files: FileList | File[],
  target: { residency: Residency; folderId: string | null },
  client: QueryClient,
): Promise<void> {
  const owner = currentEngineUser();
  const wanted = (id: string) => currentEngineUser() === owner && useLibraryFileImports.getState().items.some((item) => item.id === id);
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
