"use client";

import { useEffect, useMemo, useRef } from "react";
import { create } from "zustand";
import { engineOrigin, servedFromEngine } from "./api";
import { getBackend, type CutBackend, type CutMode } from "./backend";
import { browserBackend } from "./backend/browser";
import { cloudBackend } from "./backend/cloud";
import { localBackend } from "./backend/local";
import {
  cancelExportJob,
  createExportJob,
  ExportRefusedError,
  runBrowserExport,
  runBrowserExportInCloud,
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
  if (residency === "cloud") return cloudBackend;
  if (residency === "browser") return browserBackend;
  return localBackend;
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
    // the same compositor drew both. A browser that can't carry the render —
    // no encoder for the codec, no scratch storage — sends it to the worker,
    // which has a whole machine. A browser-resident project renders in the tab
    // too, and borrows the same worker when the tab can't: its media goes up
    // with the job and the file comes back into its own storage. Whatever the
    // user chose, something renders it.
    const inBrowser =
      (backend.kind === "cloud" || backend.kind === "browser") &&
      (await canRenderInBrowser(doc, settings));
    const tabOwned = backend.kind !== "local";
    const abort = tabOwned ? new AbortController() : undefined;
    set((s) => ({
      local: [
        ...s.local,
        {
          id: localId,
          projectId,
          projectName,
          status: tabOwned ? "rendering" : "preparing",
          ...(tabOwned ? { progress: 0 } : {}),
          createdAt: Date.now(),
          residency: backend.kind,
          abort,
        },
      ],
    }));
    // The loop may have been idling minutes deep; this export needs the fast
    // cadence from its first frame.
    wake();
    // Every job row this export claims — a tab render's reservation, and for
    // a borrowed render the cloud row too — stays hidden behind the local row.
    let claimed: string[] = [];
    const release = () => {
      const gone = new Set(claimed);
      claimed = [];
      set((s) => ({ rendering: s.rendering.filter((id) => !gone.has(id)) }));
    };
    const fail = (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      set((s) => ({
        local: s.local.map((r) =>
          r.id === localId ? { ...r, status: "error" as const, error: msg, abort: undefined } : r
        ),
      }));
    };
    const tabOpts = {
      signal: abort?.signal,
      projectName,
      // The reservation is a real job row, so the feed would show it beside
      // the local row that carries the progress. Hide it until this tab is
      // done with it.
      onClaimed: (jobId: string) => {
        claimed.push(jobId);
        set((s) => ({ rendering: [...new Set([...s.rendering, jobId])] }));
      },
      onProgress: (progress: number) =>
        set((s) => ({
          local: s.local.map((r) => (r.id === localId ? { ...r, progress } : r)),
        })),
    };
    // The worker renders what the tab could not: a cloud project's own media
    // is already there, a browser project's goes up with the job.
    const renderOnWorker = async () => {
      release();
      if (backend.kind === "browser") {
        await runBrowserExportInCloud(projectId, doc, settings, tabOpts);
        return;
      }
      set((s) => ({
        local: s.local.map((r) =>
          r.id === localId ? { ...r, status: "preparing" as const, progress: undefined, abort: undefined } : r
        ),
      }));
      await createExportJob(projectId, doc, settings);
    };
    try {
      if (inBrowser) {
        try {
          await runBrowserExport(projectId, doc, settings, tabOpts);
        } catch (err) {
          // The probe said yes and the browser then failed anyway — an encoder
          // that refuses mid-stream, scratch storage that gives out. The
          // export goes to the worker and the user sees it carry on, never an
          // error for a render they could not have done anything about. A
          // stopped render is theirs, and a gate's refusal is final: the
          // worker sits behind the same gate.
          if (err instanceof DOMException && err.name === "AbortError") throw err;
          if (err instanceof ExportRefusedError) throw err;
          await renderOnWorker();
        }
      } else {
        await renderOnWorker();
      }
      // Pull the finished (or queued) job into the feed *before* retiring the
      // placeholder — dropping the local row first left a round-trip with
      // neither row on screen — and while the job row is still hidden, since
      // showing it early stacked two identical cards for the same round-trip.
      // One set() then swaps the placeholder for the job row. A failed poll
      // must not mark a started export as a start error, so it never reaches
      // the catch below.
      await get().refresh().catch(() => {});
      const shown = new Set(claimed);
      set((s) => ({
        rendering: s.rendering.filter((id) => !shown.has(id)),
        local: s.local.filter((r) => r.id !== localId),
      }));
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
    // browser can reach: local once an engine has answered, the cloud while
    // the browser is online and the feed isn't backing off after failures.
    // The local engine is on localhost, so it stays reachable offline.
    const pollLocal = engineOrigin() !== "" || servedFromEngine();
    const pollCloud =
      (typeof navigator === "undefined" || navigator.onLine) &&
      Date.now() >= cloudRetryAt;
    // The browser feed is this tab's own memory, so it always answers.
    const [localRows, cloudRows, browserRows] = await Promise.all([
      pollLocal ? fetchFeed(localBackend) : Promise.resolve(null),
      pollCloud ? fetchFeed(cloudBackend) : Promise.resolve(null),
      fetchFeed(browserBackend),
    ]);
    if (pollCloud) {
      if (cloudRows === null) {
        cloudFailures++;
        cloudRetryAt = Date.now() + Math.min(3000 * 2 ** cloudFailures, 60_000);
      } else {
        cloudFailures = 0;
        cloudRetryAt = 0;
      }
    }
    set((s) => {
      // A failed or skipped feed keeps its previous rows; only a fresh answer
      // replaces that backend's slice.
      const slice = (kind: CutMode, fresh: ExportJob[] | null) =>
        fresh ?? s.jobs.filter((j) => j.residency === kind);
      const jobs = [
        ...slice("local", localRows),
        ...slice("cloud", cloudRows),
        ...slice("browser", browserRows),
      ];
      return {
        jobs,
        dismissed: s.dismissed.filter((id) => jobs.some((j) => j.id === id)),
      };
    });
  },
}));

/** One row a surface shows: an engine job, or a local row this tab owns. */
export type ExportRow =
  | { kind: "job"; data: ExportJob }
  | { kind: "local"; data: LocalRow };

/** Running first, then waiting, then what has settled. */
const statusRank = (status: string) =>
  status === "running" || status === "rendering"
    ? 0
    : status === "queued" || status === "preparing"
      ? 1
      : status === "done"
        ? 2
        : 3;

/**
 * Every export row a surface should show, in that order — the one assembly the
 * dock and the Media tab share, so the two never disagree about what is in
 * flight.
 *
 * A render this tab is doing itself appears once: the local row carries the
 * progress, and the reserved job row behind it is held back until the render
 * settles. Pass a projectId to narrow it to one project's work.
 *
 * Dismissal is left to the caller. `dismissed` is the dock's own hide list —
 * an X there on a still-running export silences the notification while the
 * render carries on — and the Media tab, which is the project's record of its
 * work and the only place with a cancel, keeps showing it.
 */
export function useExportRows(projectId?: string): ExportRow[] {
  const jobs = useExports((s) => s.jobs);
  const local = useExports((s) => s.local);
  const rendering = useExports((s) => s.rendering);
  return useMemo(() => {
    const mine = (x: { projectId: string }) => !projectId || x.projectId === projectId;
    return [
      ...jobs
        .filter((j) => mine(j) && !rendering.includes(j.id))
        .map((j) => ({ kind: "job" as const, data: j })),
      ...local.filter(mine).map((r) => ({ kind: "local" as const, data: r })),
    ].sort((a, b) => {
      const dr = statusRank(a.data.status) - statusRank(b.data.status);
      return dr !== 0 ? dr : (a.data.createdAt ?? 0) - (b.data.createdAt ?? 0);
    });
  }, [jobs, local, rendering, projectId]);
}

/** True while that row is still being worked on. */
export const exportInFlight = (row: ExportRow) => statusRank(row.data.status) <= 1;

/** Whether {@link ExportsState.cancel} can actually stop this row. A job is
 * cancelable through its backend, and a render this tab is doing itself
 * through the controller it holds. The seconds a local row spends handing the
 * cut to the engine ("preparing") hold no controller: that hand-off runs to
 * the job it creates, which is cancelable the moment it joins the feed. */
export const exportCancelable = (row: ExportRow) =>
  row.kind === "job" ? exportInFlight(row) : !!row.data.abort;

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
// open. Three cadences: fast while this tab has work in flight, a widening idle
// interval otherwise, and parked while the tab is hidden with nothing running.
//
// The idle poll exists to find jobs this tab never started — another tab, an
// engine job that outlived a reload, the cloud render worker — so it can't stop
// on an empty feed. It widens instead, and anything that means the user is back
// (the tab shown, the window focused, the network returning) or that work just
// started snaps it to the floor and polls immediately.
const ACTIVE_MS = 700;
const IDLE_MIN_MS = 3000;
const IDLE_MAX_MS = 30_000;

// The cloud feed drops out while the browser is offline and backs off while the
// server is unreachable; coming back online resets both and polls right away.
let cloudFailures = 0;
let cloudRetryAt = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let ticking = false;
let mounts = 0;
let idleMs = IDLE_MIN_MS;

const hidden = () => typeof document !== "undefined" && document.hidden;

/** Work this tab is showing progress for: its own rows plus any unfinished job
 * in either feed. */
const inFlight = () => {
  const s = useExports.getState();
  return (
    s.local.length > 0 || s.jobs.some((j) => j.status === "queued" || j.status === "running")
  );
};

const schedule = (ms: number) => {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = setTimeout(tick, ms);
};

const tick = async () => {
  pollTimer = null;
  if (mounts === 0 || ticking) return;
  ticking = true;
  try {
    await useExports.getState().refresh();
  } finally {
    ticking = false;
  }
  if (mounts === 0) return;
  if (inFlight()) {
    idleMs = IDLE_MIN_MS;
    schedule(ACTIVE_MS);
    return;
  }
  // Idle and out of sight: park. A visibility, focus, or online event restarts
  // the loop at the floor, and a tab still tracking an export never gets here.
  if (hidden()) return;
  schedule(idleMs);
  idleMs = Math.min(idleMs * 2, IDLE_MAX_MS);
};

/** Snap back to the fast cadence and poll now. */
const wake = () => {
  idleMs = IDLE_MIN_MS;
  // A tick already in flight schedules the next one off the reset interval.
  if (mounts === 0 || ticking) return;
  schedule(0);
};

const handleOnline = () => {
  cloudFailures = 0;
  cloudRetryAt = 0;
  wake();
};

const handleVisibility = () => {
  if (hidden()) {
    // Park immediately rather than waiting out the pending interval; work in
    // flight keeps polling so its landing still registers.
    if (!inFlight() && pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    return;
  }
  wake();
};

export function beginExportPolling() {
  mounts++;
  if (mounts > 1) return;
  window.addEventListener("online", handleOnline);
  window.addEventListener("focus", handleVisibility);
  document.addEventListener("visibilitychange", handleVisibility);
  idleMs = IDLE_MIN_MS;
  schedule(0);
}

export function endExportPolling() {
  mounts = Math.max(0, mounts - 1);
  if (mounts === 0) {
    window.removeEventListener("online", handleOnline);
    window.removeEventListener("focus", handleVisibility);
    document.removeEventListener("visibilitychange", handleVisibility);
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }
}
