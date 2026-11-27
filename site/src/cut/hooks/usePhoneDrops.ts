"use client";

// Where files sent from a phone land in the open page. The app shell lands
// Library files from anywhere in the app; the editor lands its own project's
// files, through the same import an Upload in its Media panel uses.
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { uploadInFlight } from "@/cut/lib/importQueue";
import { bindPhoneLanding, landProjectFiles } from "@/cut/lib/phoneDrop";
import { useEditor } from "@/cut/lib/store";

/** The editor's import, as far as a phone's file needs it. */
export type ProjectImport = (
  files: File[],
  opts: {
    mediaOnly: boolean;
    folderId?: string;
    onOutcome: (result: { file: File; assetId: string } | { file: File; failed: true }) => void;
  },
) => Promise<unknown>;

/** How long a landed file's bytes may take to reach project storage before
 * the staged copy is kept for another pass. */
const STORED_TIMEOUT_MS = 20 * 60 * 1000;
const STORED_POLL_MS = 500;

/** The app shell: Library files land wherever the person is in the app. */
export function usePhoneLanding() {
  const client = useQueryClient();
  useEffect(() => {
    bindPhoneLanding(client);
  }, [client]);
}

/** The editor: files sent to this project land in its Project Files. Answers
 * how many are still on a phone, for the top bar's upload count. */
export function usePhoneProjectLanding(projectId: string | null, importFiles: ProjectImport): number {
  const [sending, setSending] = useState(0);
  const importRef = useRef(importFiles);
  useEffect(() => {
    importRef.current = importFiles;
  }, [importFiles]);

  useEffect(() => {
    if (!projectId) {
      return;
    }
    const stop = landProjectFiles(
      projectId,
      async (file, folderId) => (await importStored((f, o) => importRef.current(f, o), file, folderId)) !== null,
      setSending,
    );
    return () => {
      stop();
      setSending(0);
    };
  }, [projectId]);

  return sending;
}

/** Import one file into the open project and wait until its bytes are in
 * project storage. Answers the asset's id, or null when it did not get there.
 * A half-import is taken back out, so the staged copy can go round again.
 * `onPlaced` hears the asset as soon as it exists: Replace picks it then. */
export async function importStored(
  importFiles: ProjectImport,
  file: File,
  folderId: string | null,
  onPlaced?: (assetId: string) => void,
): Promise<string | null> {
  let assetId: string | null = null;
  await importFiles([file], {
    mediaOnly: true,
    folderId: folderId ?? undefined,
    onOutcome: (result) => {
      if ("assetId" in result) {
        assetId = result.assetId;
      }
    },
  });
  const id: string | null = assetId;
  if (!id) {
    return null;
  }
  onPlaced?.(id);

  // The import queue holds a job while the bytes are in flight or retryable.
  const deadline = Date.now() + STORED_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!useEditor.getState().assets.some((a) => a.id === id)) {
      return null;
    }
    if (!uploadInFlight(id)) {
      return id;
    }
    await new Promise((resolve) => setTimeout(resolve, STORED_POLL_MS));
  }
  useEditor.getState().removeAsset(id);
  return null;
}
