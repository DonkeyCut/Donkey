"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { refFromLibrary, type AssetRef } from "@/cut/lib/assetRef";
import { ensureUploadsFolder, type LibraryAsset } from "@/cut/lib/library";
import { dismissLibraryImport, importLibraryFiles, useLibraryImports } from "@/cut/lib/libraryIntake";
import type { Residency } from "@/cut/lib/residency";
import { useDescribeError } from "@/i18n/describeError";

/** One file on its way into the prompt: a chip while it uploads, an
 * attachment once it has landed in Assets. */
export type UploadChip = {
  id: string;
  name: string;
  mediaType?: LibraryAsset["type"];
  /** A local picture of the file for the chip, released with the chip. */
  thumb?: string;
  state: "uploading" | "done" | "failed";
  ref?: AssetRef;
};

// The kinds a chip can picture from the file itself.
const PICTURED = new Set<LibraryAsset["type"] | undefined>(["image", "video"]);

/**
 * Files dropped or pasted on Home. Each one uploads in the background into
 * the Uploads folder in Assets, on the shelf new projects go to, and becomes
 * an attachment the prompt sends with when it lands.
 */
export function useHomeUploads(residency: Residency) {
  const t = useTranslations("home.start");
  const describeError = useDescribeError();
  const client = useQueryClient();
  const [chips, setChips] = useState<UploadChip[]>([]);
  const [error, setError] = useState<string | null>(null);

  // The intake's own list says which uploads failed.
  const failed = useLibraryImports((s) => s.items.filter((item) => !!item.error).map((item) => item.id).join("\n"));
  const failedIds = new Set(failed ? failed.split("\n") : []);
  const shown = chips.map((c) => (c.state === "uploading" && failedIds.has(c.id) ? { ...c, state: "failed" as const } : c));

  // Pictures made for chips are released when Home goes away.
  const thumbs = useRef(new Set<string>());
  useEffect(() => {
    const made = thumbs.current;
    return () => {
      for (const url of made) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

  const add = useCallback(
    async (files: File[]) => {
      if (files.length === 0) {
        return;
      }
      setError(null);
      try {
        const folder = await ensureUploadsFolder(residency, t("uploadsFolder"));
        await importLibraryFiles(files, { residency, folderId: folder?.id ?? null }, client, {
          prepared: (arrival) => {
            const thumb = arrival.file && PICTURED.has(arrival.mediaType) ? URL.createObjectURL(arrival.file) : undefined;
            if (thumb) {
              thumbs.current.add(thumb);
            }
            setChips((list) => [...list, { id: arrival.id, name: arrival.name, mediaType: arrival.mediaType, thumb, state: "uploading" }]);
          },
          landed: (id, asset) => {
            setChips((list) => list.map((c) => (c.id === id ? { ...c, state: "done", ref: refFromLibrary(asset) } : c)));
          },
        });
      } catch (e) {
        setError(describeError(e, t("uploadFailed")));
      }
    },
    [residency, client, t, describeError]
  );

  // Taking a chip off stops its upload; a landed file stays in Assets.
  const remove = useCallback((id: string) => {
    dismissLibraryImport(id);
    setChips((list) => {
      const gone = list.find((c) => c.id === id);
      if (gone?.thumb) {
        URL.revokeObjectURL(gone.thumb);
        thumbs.current.delete(gone.thumb);
      }
      return list.filter((c) => c.id !== id);
    });
  }, []);

  // A failed upload runs again on the chip it already has.
  const retry = useCallback((id: string) => {
    const item = useLibraryImports.getState().items.find((i) => i.id === id);
    void item?.run();
  }, []);

  // A sent prompt takes its chips with it; Home stays mounted behind the
  // editor, so it is empty on the way back.
  const clear = useCallback(() => {
    for (const url of thumbs.current) {
      URL.revokeObjectURL(url);
    }
    thumbs.current.clear();
    setChips([]);
  }, []);

  return {
    chips: shown,
    refs: shown.flatMap((c) => (c.ref ? [c.ref] : [])),
    uploading: shown.some((c) => c.state === "uploading"),
    anyFailed: shown.some((c) => c.state === "failed"),
    error,
    add,
    remove,
    retry,
    clear,
  };
}
