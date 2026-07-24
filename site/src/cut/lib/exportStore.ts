"use client";

import { useEffect, useRef } from "react";
import { create } from "zustand";
import { engineOrigin, servedFromEngine } from "./api";
import { getBackend, type CutBackend, type CutMode } from "./backend";
import { cloudBackend } from "./backend/cloud";
import { localBackend } from "./backend/local";
import { webModeEnabled } from "./flags";
import {
  cancelExportJob,
  createExportJob,
  type ExportDoc,
  type ExportSettings,
} from "./exportClient";
import { useGenNotify } from "./genNotify";

// Exports are tracked app-wide, not per-open-project. The engine holds every
// export job in one process-global registry, so this store is a thin reflection
// of that feed: every tab polls the same list and shows the same queue, and
// starting an export in one project while another still renders just adds a row.
// The dock (ExportsDock) renders it; the engine does the queueing.
//
// With web mode on, local and cloud jobs can be in flight at once, so the
// store reflects both backends' feeds; each row is tagged with the residency
// it came from and every per-row action goes to that row's own backend — the
// globally bound mode rebinds whenever a project of the other residency opens.

export interface ExportJob {
  id: string;
  projectId: string;
  projectName?: string;
  status: "queued" | "running" | "done" | "error";
  progress: number; // 0..1
  outName?: string;
  error?: string;
  /** Epoch ms the encode began (elapsed clock) and the job was created (order). */
  startedAt?: number;
  createdAt?: number;
  /** Which backend's feed the row came from — stamped on merge, not sent by
   * the server. */
  residency: CutMode;
}

/** The backend a dock row lives on; per-row actions hit this, never the
 * globally bound mode. */
export function exportBackend(residency: CutMode): CutBackend {
  return residency === "cloud" ? cloudBackend : localBackend;
}

/** A client-only dock row for the brief window before the engine has a job id:
 * while the cut is being built and uploaded ("preparing"), or when that failed
 * before a job ever existed ("error"). Kept apart from the engine feed so a
 * poll tick never clears it. */
export interface LocalRow {
  id: string;
  projectId: string;
  projectName?: string;
  status: "preparing" | "error";
  error?: string;
  createdAt: number;
  /** The backend the export is starting on, captured when it was kicked off. */
  residency: CutMode;
}

interface ExportsState {
  /** The engine's export feed, reflected verbatim on each poll. */
  jobs: ExportJob[];
  /** Rows that don't have an engine job yet (preparing / start error). */
  local: LocalRow[];
  /** Finished/failed engine jobs the user cleared from this tab's dock. */
  dismissed: string[];
  /** Build the cut and hand it to the engine; the dock tracks it from there. */
  start: (
    projectId: string,
    doc: ExportDoc,
    settings: ExportSettings,
    projectName?: string
  ) => Promise<void>;
  cancel: (id: string) => void;
  dismiss: (id: string) => void;
  /** Clear every finished/failed row at once; running work stays. */
  dismissSettled: () => void;
  /** One poll of the engine feed. */
  refresh: () => Promise<void>;
}

export const useExports = create<ExportsState>((set, get) => ({
  jobs: [],
  local: [],
  dismissed: [],

  start: async (projectId, doc, settings, projectName) => {
    const localId = `local-${crypto.randomUUID().slice(0, 8)}`;
    set((s) => ({
      local: [
        ...s.local,
        {
          id: localId,
          projectId,
          projectName,
          status: "preparing",
          createdAt: Date.now(),
          residency: getBackend().kind,
        },
      ],
    }));
    try {
      await createExportJob(projectId, doc, settings);
      set((s) => ({ local: s.local.filter((r) => r.id !== localId) }));
      void get().refresh(); // show the queued job now, not on the next tick
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set((s) => ({
        local: s.local.map((r) =>
          r.id === localId ? { ...r, status: "error", error: msg } : r
        ),
      }));
    }
  },

  cancel: (id) => {
    const job = get().jobs.find((j) => j.id === id);
    cancelExportJob(id, job ? exportBackend(job.residency) : undefined);
    set((s) => ({
      jobs: s.jobs.map((j) =>
        j.id === id ? { ...j, status: "error", error: "Export canceled." } : j
      ),
    }));
    void get().refresh();
  },

  dismiss: (id) => {
    // A settled row is retired from its backend's feed too (the same DELETE
    // that cancels a live job), so it stays gone across tabs and reloads —
    // the `dismissed` entry only hides it until the next poll confirms.
    // Hiding a still-running row stays local: the export keeps rendering.
    const job = get().jobs.find((j) => j.id === id);
    if (job && (job.status === "done" || job.status === "error")) {
      cancelExportJob(id, exportBackend(job.residency));
    }
    set((s) => ({
      local: s.local.filter((r) => r.id !== id),
      dismissed: s.jobs.some((j) => j.id === id)
        ? [...new Set([...s.dismissed, id])]
        : s.dismissed,
    }));
  },

  dismissSettled: () => {
    for (const j of get().jobs) {
      if (j.status === "done" || j.status === "error") {
        cancelExportJob(j.id, exportBackend(j.residency));
      }
    }
    set((s) => ({
      local: s.local.filter((r) => r.status !== "error"),
      dismissed: [
        ...new Set([
          ...s.dismissed,
          ...s.jobs
            .filter((j) => j.status === "done" || j.status === "error")
            .map((j) => j.id),
        ]),
      ],
    }));
  },

  refresh: async () => {
    // One backend's feed, rows stamped with its residency; null on a hiccup so
    // the caller keeps that backend's last good view.
    const fetchFeed = async (backend: CutBackend): Promise<ExportJob[] | null> => {
      try {
        const res = await backend.fetch("/api/cut/export-jobs");
        if (!res.ok) return null;
        const list = (await res.json()) as ExportJob[];
        return list.map((j) => ({ ...j, residency: backend.kind }));
      } catch {
        return null;
      }
    };
    // Flag off: exactly the pre-seam behavior — the local feed only. Flag on,
    // jobs of both residencies can run at once, so poll every plausible feed:
    // local when an engine is actually reachable, cloud always.
    const cloudOn = webModeEnabled();
    const pollLocal = !cloudOn || engineOrigin() !== "" || servedFromEngine();
    const [localRows, cloudRows] = await Promise.all([
      pollLocal ? fetchFeed(localBackend) : Promise.resolve(null),
      cloudOn ? fetchFeed(cloudBackend) : Promise.resolve(null),
    ]);
    set((s) => {
      // A failed or skipped feed keeps its previous rows; only a fresh answer
      // replaces that backend's slice.
      const slice = (kind: CutMode, fresh: ExportJob[] | null) =>
        fresh ?? s.jobs.filter((j) => j.residency === kind);
      const jobs = [...slice("local", localRows), ...slice("cloud", cloudRows)];
      return {
        jobs,
        dismissed: s.dismissed.filter((id) => jobs.some((j) => j.id === id)),
      };
    });
  },
}));

/** Badge the Media tab when one of this project's exports finishes in the
 * background: watch the engine feed for jobs newly turned done and report each
 * to the gen-notify store, keyed by file name so the export row can pulse.
 * The first sight of the feed only seeds the baseline — exports that were
 * already done when the editor opened aren't news. */
export function useWatchExportLands(projectId: string) {
  const jobs = useExports((s) => s.jobs);
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    seen.current = null;
  }, [projectId]);
  useEffect(() => {
    const done = jobs.filter((j) => j.projectId === projectId && j.status === "done");
    if (seen.current === null) {
      seen.current = new Set(done.map((j) => j.id));
      return;
    }
    for (const j of done) {
      if (seen.current.has(j.id)) continue;
      seen.current.add(j.id);
      if (j.outName) useGenNotify.getState().landed("media", j.outName);
    }
  }, [jobs, projectId]);
}

// The dock is mounted app-wide, so polling runs the whole time the Cut app is
// open. It quickens while work is in flight and idles between exports.
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let mounts = 0;

export function beginExportPolling() {
  mounts++;
  if (pollTimer !== null) return;
  const tick = async () => {
    await useExports.getState().refresh();
    if (mounts === 0) {
      pollTimer = null;
      return;
    }
    const s = useExports.getState();
    const active =
      s.local.length > 0 ||
      s.jobs.some((j) => j.status === "queued" || j.status === "running");
    pollTimer = setTimeout(tick, active ? 700 : 3000);
  };
  pollTimer = setTimeout(tick, 0);
}

export function endExportPolling() {
  mounts = Math.max(0, mounts - 1);
  if (mounts === 0 && pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}
