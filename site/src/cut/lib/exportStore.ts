"use client";

import { useEffect, useRef } from "react";
import { create } from "zustand";
import { engineOrigin, servedFromEngine } from "./api";
import { getBackend, type CutBackend, type CutMode } from "./backend";
import { cloudBackend } from "./backend/cloud";
import { localBackend } from "./backend/local";
import {
  cancelExportJob,
  createExportJob,
  runBrowserExport,
  type ExportDoc,
  type ExportSettings,
} from "./exportClient";
import { canRenderInBrowser } from "./exportRender";
import { useGenNotify } from "./genNotify";

// Exports are tracked app-wide, not per-open-project. The engine holds every
// export job in one process-global registry, so this store is a thin reflection
// of that feed: every tab polls the same list and shows the same queue, and
// starting an export in one project while another still renders just adds a row.
// The dock (ExportsDock) renders it; the engine does the queueing.
//
// Local and cloud jobs can be in flight at once, so the store reflects both
// backends' feeds; each row is tagged with the residency it came from and
// every per-row action goes to that row's own backend — the globally bound
// mode rebinds whenever a project of the other residency opens.

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

/** A client-only dock row for work no server job covers: the window before the
 * engine has a job id ("preparing"), a failure that happened before a job ever
 * existed ("error"), and the whole of a browser render ("rendering"), which has
 * no server row until the file is stored. Kept apart from the engine feed so a
 * poll tick never clears it. */
export interface LocalRow {
  id: string;
  projectId: string;
  projectName?: string;
  status: "preparing" | "rendering" | "error";
  error?: string;
  /** 0..1 while rendering in this tab. */
  progress?: number;
  createdAt: number;
  /** The backend the export is starting on, captured when it was kicked off. */
  residency: CutMode;
  /** Stops a browser render; absent for work a server owns. */
  abort?: AbortController;
}

interface ExportsState {
  /** The engine's export feed, reflected verbatim on each poll. */
  jobs: ExportJob[];
  /** Rows that don't have an engine job yet (preparing / start error). */
  local: LocalRow[];
  /** Finished/failed engine jobs the user cleared from this tab's dock. */
  dismissed: string[];
  /** Reserved job rows this tab is rendering itself. They are real rows in the
   * feed, but the local row beside them is the one carrying progress, so they
   * stay hidden until the render settles. */
  rendering: string[];
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
  rendering: [],

  start: async (projectId, doc, settings, projectName) => {
    const localId = `local-${crypto.randomUUID().slice(0, 8)}`;
    const backend = getBackend();
    // A cloud project renders in the tab: no upload of the cut to a container,
    // no queue behind other accounts, and the file matches the preview because
    // the same compositor drew both. Past what a tab can hold — a long cut, a
    // very large frame — it goes to the worker, which has a whole machine.
    const inBrowser = backend.kind === "cloud" && (await canRenderInBrowser(doc, settings));
    const abort = inBrowser ? new AbortController() : undefined;
    set((s) => ({
      local: [
        ...s.local,
        {
          id: localId,
          projectId,
          projectName,
          status: inBrowser ? "rendering" : "preparing",
          ...(inBrowser ? { progress: 0 } : {}),
          createdAt: Date.now(),
          residency: backend.kind,
          abort,
        },
      ],
    }));
    let claimedId: string | null = null;
    const release = () => {
      if (claimedId) set((s) => ({ rendering: s.rendering.filter((id) => id !== claimedId) }));
    };
    const fail = (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      set((s) => ({
        local: s.local.map((r) =>
          r.id === localId ? { ...r, status: "error" as const, error: msg, abort: undefined } : r
        ),
      }));
    };
    try {
      if (inBrowser) {
        await runBrowserExport(projectId, doc, settings, {
          signal: abort!.signal,
          // The reservation is a real job row, so the feed would show it beside
          // the local row that carries the progress. Hide it until this tab is
          // done with it.
          onClaimed: (jobId) => {
            claimedId = jobId;
            set((s) => ({ rendering: [...new Set([...s.rendering, jobId])] }));
          },
          onProgress: (progress) =>
            set((s) => ({
              local: s.local.map((r) => (r.id === localId ? { ...r, progress } : r)),
            })),
        });
      } else {
        await createExportJob(projectId, doc, settings);
      }
      // Pull the finished (or queued) job into the feed *before* retiring the
      // placeholder. Dropping the local row first left a round-trip with
      // neither row on screen, which read as the export card flashing away and
      // back. A failed poll must not mark a started export as a start error, so
      // it never reaches the catch below.
      release();
      await get().refresh().catch(() => {});
      set((s) => ({ local: s.local.filter((r) => r.id !== localId) }));
    } catch (err) {
      release();
      // A render the user stopped leaves no row at all — the dock already
      // showed it going, and an error card for their own cancel reads as a
      // failure.
      if (err instanceof DOMException && err.name === "AbortError") {
        set((s) => ({ local: s.local.filter((r) => r.id !== localId) }));
        return;
      }
      fail(err);
    }
  },

  cancel: (id) => {
    const local = get().local.find((r) => r.id === id);
    if (local) {
      local.abort?.abort();
      set((s) => ({ local: s.local.filter((r) => r.id !== id) }));
      return;
    }
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
    // Jobs of both residencies can run at once, so poll every feed this
    // browser can reach: the cloud always, local once an engine has answered.
    const pollLocal = engineOrigin() !== "" || servedFromEngine();
    const [localRows, cloudRows] = await Promise.all([
      pollLocal ? fetchFeed(localBackend) : Promise.resolve(null),
      fetchFeed(cloudBackend),
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
