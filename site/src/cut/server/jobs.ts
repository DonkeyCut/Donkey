import { type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertLocalRuntime } from "./local-only";
import { createJobRegistry } from "./jobRegistry";
import { runExport, type ExportSpec } from "./exportPipeline";
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
  log: string[];
}

const MAX_RUNNING = 2; // concurrent ffmpeg exports; extra exports queue behind them
// Survives dev-server module reloads; caps the terminal backlog. Queued jobs
// are active work, not backlog, so they are exempt from eviction.
const { jobs, runningCount, retire } = createJobRegistry<Job>("__veditorJobs", {
  isTerminal: (j) => j.status === "done" || j.status === "error",
});

// Export jobs waiting for a running slot, oldest first. Held on globalThis so a
// dev-server module reload doesn't strand a queued render. Preview proxies never
// queue — they run when a slot is free and are rejected otherwise.
interface Pending {
  job: Job;
  spec: ExportSpec;
}
const g = globalThis as unknown as { __veditorPending?: Pending[] };
const pending: Pending[] = (g.__veditorPending ??= []);

// A project folder never moves while a render holds paths inside it: the
// rename-follows-name machinery asks here before touching the folder.
setActiveJobGuard((projectId) =>
  [...jobs.values()].some(
    (j) => j.projectId === projectId && (j.status === "queued" || j.status === "running")
  )
);

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
async function exportName(projectId: string, projectName: string) {
  const base =
    projectName.replace(/[/\\:*?"<>|]/g, "").trim().slice(0, 60) || "export";
  const taken = new Set(
    await readdir(exportsDir(projectId)).catch(() => [] as string[])
  );
  for (const j of jobs.values()) {
    if (j.projectId === projectId && j.outName) taken.add(j.outName);
  }
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${base}.mp4` : `${base} ${n}.mp4`;
    if (!taken.has(candidate)) return candidate;
  }
}

// Names resolve one job at a time: exportName only sees a competing job once
// its outName is assigned, so two jobs racing through their first awaits could
// otherwise both claim "<Project>.mp4" and overwrite each other's render.
let namingQueue: Promise<unknown> = Promise.resolve();
function claimExportName(job: Job, projectName: string): Promise<void> {
  const claim = namingQueue.then(async () => {
    job.outName = await exportName(job.projectId, projectName);
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
    else await claimExportName(job, doc.name);
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
