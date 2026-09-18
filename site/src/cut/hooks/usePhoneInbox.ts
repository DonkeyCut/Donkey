"use client";

import { useEffect, useRef } from "react";

import { apiFetch } from "@/cut/lib/api";
import { getBackend } from "@/cut/lib/backend";
import { assetFromProjectFile } from "@/cut/lib/media";
import { useLocalCompute } from "@/cut/lib/backend/hooks";
import { uploadInFlight } from "@/cut/lib/importQueue";
import { useEditor } from "@/cut/lib/store";

/** A clip waiting on this Mac, shot on a paired phone. */
type PhoneClip = {
  id: string;
  fileName: string;
  bytes: number;
  capturedAt: number;
  deviceName: string;
};

/** How often the editor looks for clips a phone has handed over. A readdir on
 * loopback, and only while a phone is actually paired. */
const POLL_MS = 4000;
/** How often it re-checks whether a phone is paired at all, which is what turns
 * the clip poll on. */
const PAIRED_POLL_MS = 60_000;
/** How long the hook waits for an asset's bytes to finish reaching storage
 * before it leaves the clip in the inbox for another pass. Generous: a field
 * take on a slow uplink is minutes. */
const LANDED_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Field clips reaching the open project.
 *
 * A phone shooting with no network hands its takes to the Mac app over
 * peer-to-peer Wi-Fi, and the app leaves them in the engine's inbox. This is the
 * other end: the open editor takes each one and imports it the way any file
 * import lands, so it works the same whether the project lives in this page's
 * OPFS, on this Mac, or in the cloud.
 *
 * Two rules make it safe to let the Mac's copy go. A clip is claimed before it
 * is read, so two open editors cannot both take it — the engine hands the claim
 * to exactly one of them. And it is deleted only once its bytes are actually in
 * the project's storage, which for a cloud project is after the upload has
 * finished, not after the asset appears on screen. Anything short of that puts
 * the clip back, because the phone has already stopped offering it.
 */
export function usePhoneInbox(
  importFiles: (
    files: File[],
    opts?: {
      mediaOnly?: boolean;
      onOutcome?: (r: { file: File; assetId: string } | { file: File; failed: true }) => void;
    }
  ) => Promise<unknown>
) {
  const hasEngine = useLocalCompute();
  // The import function is rebuilt on every editor render; the loop reads the
  // latest through a ref so it is never restarted by one.
  const importRef = useRef(importFiles);
  useEffect(() => {
    importRef.current = importFiles;
  }, [importFiles]);

  useEffect(() => {
    if (!hasEngine) return;
    let stopped = false;
    let working = false;
    let paired = false;
    let lastPairedCheck = 0;

    /** Take the clip into the open project, and say whether its bytes got there. */
    const land = async (clip: PhoneClip): Promise<boolean> => {
      const backend = getBackend();
      const projectId = useEditor.getState().projectId;
      if (!projectId) return false;

      // A project on this Mac is the case where the page has no business
      // carrying the bytes: the clip and the project are both on this disk, so
      // the engine moves the file and the editor only registers what landed.
      if (backend.kind === "local") {
        const res = await apiFetch(`/api/cut/phone/clips/${clip.id}/into-project`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId }),
        });
        if (!res.ok) return false;
        const { fileName } = (await res.json()) as { fileName: string };
        await registerMoved(projectId, fileName);
        return true;
      }

      const res = await apiFetch(`/api/cut/phone/clips/${clip.id}/file`);
      if (!res.ok) return false;
      const blob = await res.blob();
      const file = new File([blob], clip.fileName, {
        type: blob.type || "video/quicktime",
        lastModified: clip.capturedAt,
      });

      let landedId: string | null = null;
      await importRef.current([file], {
        mediaOnly: true,
        onOutcome: (r) => {
          if ("assetId" in r) landedId = r.assetId;
        },
      });
      if (!landedId) return false;
      if (await stored(landedId)) return true;
      // The bytes never reached storage. The asset would sit in the project
      // pointing at nothing, and the clip is going back in the inbox for
      // another pass, so take the half-import out of the way of that.
      useEditor.getState().removeAsset(landedId);
      return false;
    };

    /** Wait for the asset's bytes to reach project storage. The import queue
     * holds a job for as long as one is in flight or retryable, so the clip is
     * safe to drop once that job is gone and the asset is still here. */
    const stored = async (assetId: string): Promise<boolean> => {
      const deadline = Date.now() + LANDED_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (stopped) return false;
        const present = useEditor.getState().assets.some((a) => a.id === assetId);
        if (!present) return false;
        if (!uploadInFlight(assetId)) return true;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return false;
    };

    /** Register a clip the engine moved into the project's media folder. The
     * bytes are already where they belong, so this only probes the file for its
     * duration and size and puts the asset in the Media panel — nothing about
     * the clip passes through this tab.
     *
     * The move already happened, so the clip is landed either way: a probe that
     * fails leaves the file in the project without an asset pointing at it,
     * which is a file to find rather than a take to lose. */
    const registerMoved = async (projectId: string, fileName: string): Promise<void> => {
      try {
        const asset = await assetFromProjectFile(projectId, fileName, fileName);
        const store = useEditor.getState();
        // The probe outlives a project switch; the file is in the other
        // project's folder, so it must not be filed into whatever is open now.
        if (store.projectId === projectId) store.addAsset(asset);
      } catch {
        // The bytes are in the project; the next open of it lists them.
      }
    };

    const take = async (clip: PhoneClip) => {
      const claim = await apiFetch(`/api/cut/phone/clips/${clip.id}/claim`, { method: "POST" });
      // 409: another editor has it. Nothing to do and nothing to put back.
      if (!claim.ok) return;
      let landed = false;
      try {
        landed = await land(clip);
      } catch {
        landed = false;
      }
      await apiFetch(
        landed ? `/api/cut/phone/clips/${clip.id}` : `/api/cut/phone/clips/${clip.id}/release`,
        { method: landed ? "DELETE" : "POST" }
      );
    };

    const tick = async () => {
      if (working) return;
      working = true;
      try {
        const now = Date.now();
        if (now - lastPairedCheck > PAIRED_POLL_MS) {
          lastPairedCheck = now;
          const res = await apiFetch("/api/cut/phone");
          const body = res.ok ? ((await res.json()) as { devices?: unknown[] }) : null;
          paired = (body?.devices?.length ?? 0) > 0;
        }
        if (!paired) return;
        const res = await apiFetch("/api/cut/phone/clips");
        if (!res.ok) return;
        const { clips = [] } = (await res.json()) as { clips?: PhoneClip[] };
        for (const clip of clips) {
          if (stopped) return;
          await take(clip);
        }
      } catch {
        // The app quit, or the engine is restarting after an update. The next
        // tick finds it again.
      } finally {
        working = false;
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [hasEngine]);
}
