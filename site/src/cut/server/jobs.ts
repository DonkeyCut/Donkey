import { type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertLocalRuntime } from "./local-only";
import { createJobRegistry } from "./jobRegistry";
import { containerExtension, runExport, type ExportSpec } from "./exportPipeline";
import { exportsDir, mediaPath, projectDir, readProject, setActiveJobGuard } from "./projects";

export type { ExportSpec } from "./exportPipeline";

export interface Job {
  id: string;
  projectId: string;
  /** Shown in the exports dock; the engine assigns it from the project doc. */
  projectName: string;
  /** "preview" is the internal hover-proxy render; only "export" jobs are
   * surfaced to the client dock for progress/download. */
  target: "export" | "preview";
  /** "queued" waits for a running slot; the rest track the ffmpeg run. */
  status: "queued" | "running" | "done" | "error";
  progress: number; // 0..1
  error?: string;
  /** When the job was created (queue order) and when it actually began the
   * encode (elapsed clock in the dock). */
  createdAt: number;
  startedAt?: number;
  tmpDir: string;
  outPath: string;
  outName: string;
  proc?: ChildProcess;
  /** A render the browser tab carries itself: the row holds the file's name
   * and the dock's slot while the tab draws the frames, and the finished file
   * streams in when it is done. The engine encodes nothing for it. */
  client?: boolean;
  /** A tab render's last sign of life: its claim, a progress report, or the
   * start of its hand-in. */
  seenAt?: number;
  log: string[];
}

const MAX_RUNNING = 2; // concurrent ffmpeg exports; extra exports queue behind them
// Survives dev-server module reloads; caps the terminal backlog. Queued jobs
// are active work, not backlog, so they are exempt from eviction.
const { jobs, retire } = createJobRegistry<Job>("__veditorJobs", {
  isTerminal: (j) => j.status === "done" || j.status === "error",
});

/** Renders holding an ffmpeg slot. A tab's own render is in the feed with
 * status "running" and takes none: the encoding happens in the browser. */
const runningCount = () => {
  let n = 0;
  for (const j of jobs.values()) if (j.status === "running" && !j.client) n++;
  return n;
};

// Export jobs waiting for a running slot, oldest first. Held on globalThis so a
// dev-server module reload doesn't strand a queued render. Preview proxies never
// queue — they run when a slot is free and are rejected otherwise.
interface Pending {
  job: Job;
  spec: ExportSpec;
}
const g = globalThis as unknown as { __veditorPending?: Pending[] };
const pending: Pending[] = (g.__veditorPending ??= []);

/** How long a tab render may go quiet before its row is given up. The tab
 * reports every few seconds while it draws; a tab that closed, crashed, or
 * lost the page mid-render stops, and its row would otherwise hold the file
 * name and the project's busy flag forever. Long enough to ride out a hidden
 * tab's throttled timers. */
const CLIENT_RENDER_WINDOW_MS = 3 * 60 * 1000;

/** Settle every tab render that fell silent: the row errors and retires, so
 * the name frees, the folder may follow its project's name again, and the
 * docks stop polling for a render nothing is drawing. */
function sweepClientJobs(now = Date.now()): void {
  for (const job of jobs.values()) {
    if (!job.client || job.status !== "running") continue;
    if (now - (job.seenAt ?? job.startedAt ?? job.createdAt) < CLIENT_RENDER_WINDOW_MS) continue;
    job.status = "error";
    job.error = "The tab rendering this export went away.";
    retire(job);
  }
}

// A project folder never moves while a render holds paths inside it: the
// rename-follows-name machinery asks here before touching the folder.
setActiveJobGuard((projectId) => {
  sweepClientJobs();
  return [...jobs.values()].some(
    (j) => j.projectId === projectId && (j.status === "queued" || j.status === "running")
  );
});

/** Promote queued exports into free running slots, oldest first. Called after
 * every enqueue and every settle, so the queue always drains to capacity. */
function pump() {
  while (runningCount() < MAX_RUNNING && pending.length > 0) {
    const next = pending.shift()!;
    if (next.job.status !== "queued") continue; // canceled while waiting
    startRun(next.job, next.spec);
  }
}

/** Move a job from queued to running and drive its ffmpeg render. Its settle
 * frees the slot and pumps the queue. */
function startRun(job: Job, spec: ExportSpec) {
  job.status = "running";
  job.startedAt = Date.now();
  void runExport(job, spec, (file) => mediaPath(spec.projectId, file))
    .then(() => {
      job.status = "done";
    })
    .catch((err: unknown) => {
      job.status = "error";
      job.error = err instanceof Error ? err.message : String(err);
      void rm(job.outPath, { force: true }); // no half-written files in exports/
    })
    .finally(() => {
      void rm(job.tmpDir, { recursive: true, force: true }); // overlay tmp, win or lose
      retire(job);
      pump();
    });
}

export function getJob(id: string) {
  return jobs.get(id);
}

/** One export job's dock view: enough for the client to show progress, elapsed,
 * queue position, and the finished file's actions. Previews stay internal. */
function jobView(j: Job) {
  return {
    id: j.id,
    projectId: j.projectId,
    projectName: j.projectName,
    status: j.status,
    progress: j.progress,
    outName: j.outName || undefined,
    error: j.error,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
  };
}

/** Every export job across all projects — the source of truth the app-wide
 * exports dock reflects, so it shows the same set in every tab. */
export function listAllJobs() {
  sweepClientJobs();
  return [...jobs.values()]
    .filter((j) => j.target !== "preview")
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(jobView);
}

export function cancelJob(id: string) {
  const job = jobs.get(id);
  if (!job) return;
  if (job.status === "running" && job.proc) {
    job.proc.kill("SIGKILL");
    job.status = "error";
    job.error = "Export canceled.";
    retire(job);
  } else if (job.status === "running" && job.client) {
    // The tab drawing it learns of the cancel when it comes to hand the file
    // in and is refused; the row settles now so every dock clears.
    job.status = "error";
    job.error = "Export canceled.";
    retire(job);
  } else if (job.status === "queued") {
    // Never started: drop it from the queue and settle it so the dock clears.
    job.status = "error";
    job.error = "Export canceled.";
    const i = pending.findIndex((p) => p.job.id === id);
    if (i >= 0) pending.splice(i, 1);
    retire(job);
  } else if (job.status === "done" || job.status === "error") {
    // Dismissed from the dock: drop it from the feed for good. A finished
    // file stays on disk in exports/.
    jobs.delete(id);
  }
}

/** Export file named after the project, with a " 2", " 3"… suffix when the
 * name is already taken by a file on disk or an export still in flight. */
async function exportName(projectId: string, projectName: string, ext: string) {
  const base =
    projectName.replace(/[/\\:*?"<>|]/g, "").trim().slice(0, 60) || "export";
  const taken = new Set(
    await readdir(exportsDir(projectId)).catch(() => [] as string[])
  );
  // A failed job wrote nothing under its name; only live and finished ones
  // hold theirs.
  for (const j of jobs.values()) {
    if (j.projectId === projectId && j.outName && j.status !== "error") taken.add(j.outName);
  }
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${base}${ext}` : `${base} ${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// Names resolve one job at a time: exportName only sees a competing job once
// its outName is assigned, so two jobs racing through their first awaits could
// otherwise both claim "<Project>.mp4" and overwrite each other's render.
let namingQueue: Promise<unknown> = Promise.resolve();
function claimExportName(job: Job, projectName: string, ext: string): Promise<void> {
  const claim = namingQueue.then(async () => {
    job.outName = await exportName(job.projectId, projectName, ext);
  });
  namingQueue = claim.catch(() => {});
  return claim;
}

export async function createJob(form: FormData): Promise<Job> {
  assertLocalRuntime();
  const spec = JSON.parse(String(form.get("spec"))) as ExportSpec;
  const id = crypto.randomUUID().slice(0, 12);
  const preview = spec.target === "preview";

  // Previews are best-effort hover proxies: they take a free slot or bow out,
  // never queueing. Queued exports already hold every slot (pump keeps the
  // registry full while any wait), so this cap check also stops a preview from
  // jumping the export queue.
  if (preview && runningCount() >= MAX_RUNNING) {
    const job: Job = {
      id,
      projectId: spec.projectId,
      projectName: "",
      target: "preview",
      status: "error",
      progress: 0,
      createdAt: Date.now(),
      tmpDir: "",
      outPath: "",
      outName: "",
      error: "Another export is already running — wait for it to finish.",
      log: [],
    };
    jobs.set(id, job);
    retire(job);
    return job;
  }

  const job: Job = {
    id,
    projectId: spec.projectId,
    projectName: "",
    target: preview ? "preview" : "export",
    status: "queued",
    progress: 0,
    createdAt: Date.now(),
    tmpDir: "",
    outPath: "",
    outName: "",
    log: [],
  };
  jobs.set(id, job);

  try {
    const doc = await readProject(spec.projectId);
    if (!doc) throw new Error("Project not found.");
    job.projectName = doc.name;
    if (preview) job.outName = "preview.mp4";
    else await claimExportName(job, doc.name, containerExtension(spec));
    job.outPath = path.join(
      preview ? projectDir(spec.projectId) : exportsDir(spec.projectId),
      job.outName
    );
    await mkdir(path.dirname(job.outPath), { recursive: true });
    job.tmpDir = await mkdtemp(path.join(os.tmpdir(), "veditor-"));
    // Overlay PNGs are rendered in the browser and uploaded with the spec.
    for (const [key, value] of form.entries()) {
      if (value instanceof File && key !== "spec") {
        await writeFile(path.join(job.tmpDir, path.basename(key)), Buffer.from(await value.arrayBuffer()));
      }
    }
    if (preview) {
      // Re-check the slot: it may have been taken during the prep above. A
      // dropped preview just refreshes later, so bow out instead of racing.
      if (runningCount() < MAX_RUNNING) startRun(job, spec);
      else {
        job.status = "error";
        job.error = "Another export is already running — wait for it to finish.";
        void rm(job.tmpDir, { recursive: true, force: true });
        retire(job);
      }
    } else {
      pending.push({ job, spec });
      pump();
    }
  } catch (err) {
    job.status = "error";
    job.error = err instanceof Error ? err.message : String(err);
    if (job.tmpDir) void rm(job.tmpDir, { recursive: true, force: true });
    retire(job);
  }
  return job;
}

/**
 * Open a job for a render the tab carries itself. The name is claimed and the
 * row enters the feed as running, so every dock shows it and no other export
 * can take its file name; the frames are the browser's to draw.
 */
export async function createClientJob(
  projectId: string,
  container: ExportSpec["container"]
): Promise<Job> {
  assertLocalRuntime();
  sweepClientJobs();
  const job: Job = {
    id: crypto.randomUUID().slice(0, 12),
    projectId,
    projectName: "",
    target: "export",
    status: "running",
    progress: 0,
    createdAt: Date.now(),
    startedAt: Date.now(),
    seenAt: Date.now(),
    tmpDir: "",
    outPath: "",
    outName: "",
    client: true,
    log: [],
  };
  jobs.set(job.id, job);
  try {
    const doc = await readProject(projectId);
    if (!doc) throw new Error("Project not found.");
    job.projectName = doc.name;
    await claimExportName(job, doc.name, containerExtension({ container }));
    job.outPath = path.join(exportsDir(projectId), job.outName);
    await mkdir(path.dirname(job.outPath), { recursive: true });
  } catch (err) {
    job.status = "error";
    job.error = err instanceof Error ? err.message : String(err);
    retire(job);
  }
  return job;
}

/** How far the tab has drawn, for the docks in every other tab. A report is
 * also the tab's heartbeat, whatever the ratio. */
export function progressClientJob(id: string, ratio: number): void {
  const job = jobs.get(id);
  if (!job?.client || job.status !== "running") return;
  job.seenAt = Date.now();
  if (Number.isFinite(ratio)) job.progress = Math.max(job.progress, Math.min(1, Math.max(0, ratio)));
}

/**
 * The finished file, streamed into exports/ under the claimed name. Null when
 * the job is no longer a running tab render — canceled from another dock, or
 * never one at all — so the tab knows its file has nowhere to go.
 */
export async function completeClientJob(
  id: string,
  body: ReadableStream<Uint8Array> | null
): Promise<Job | null> {
  const job = jobs.get(id);
  if (!job?.client || job.status !== "running") return null;
  job.seenAt = Date.now();
  const partial = `${job.outPath}.part`;
  try {
    if (!body) throw new Error("The export arrived without a file.");
    // Read chunk by chunk into a file handle. A body whose connection drops
    // rejects the loop, so the catch below runs; under Bun the Node stream
    // adapter hangs on the same body and leaks the rejection.
    const file = await open(partial, "w");
    try {
      for await (const chunk of body) await file.write(chunk);
    } finally {
      await file.close();
    }
    await rename(partial, job.outPath);
    job.status = "done";
    job.progress = 1;
  } catch (err) {
    await rm(partial, { force: true });
    job.status = "error";
    job.error = err instanceof Error ? err.message : String(err);
  } finally {
    retire(job);
  }
  return job;
}

/** A tab render that stopped before its file landed gives the name and the
 * row back; nothing of it stays in the feed. That covers a render the tab
 * abandoned while still running and one whose hand-in broke off — a cancel
 * that lands mid-stream errors the row first, and the tab's release then
 * takes it out so no dock shows a failure card for the user's own stop. A
 * finished file keeps its row. */
export function releaseClientJob(id: string): void {
  const job = jobs.get(id);
  if (!job?.client || job.status === "done") return;
  jobs.delete(id);
}

/** Test seam: settle tab renders that have been silent longer than the window. */
export function sweepClientJobsForTest(now: number): void {
  sweepClientJobs(now);
}
