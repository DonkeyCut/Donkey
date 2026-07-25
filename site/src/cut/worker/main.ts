import type { Prisma } from "@/generated/prisma/client";
import type { RenderHandle } from "../server/exportPipeline";
import { prisma, type ClaimedJob } from "./db";
import { overlayKeysOf, runExportJob } from "./exportJob";
import { runImportUrlJob } from "./importUrlJob";
import { deleteObjects } from "./r2";

// The cloud render worker: a headless loop that claims CutRenderJob rows the
// hosted API queues (export, preview, import_url), executes them with the
// same pipeline code the local engine runs, and writes progress and results
// back to the row the client polls. One process, MAX_RUNNING jobs at a time,
// horizontal scale by adding replicas — the atomic claim keeps them apart.

const MAX_RUNNING = 2; // mirrors the engine's concurrent-ffmpeg cap
const IDLE_POLL_MS = 2000;
const WATCH_MS = 1000; // progress write + cancellation check cadence
// Drain-and-exit: once the queue stays empty this long with nothing running,
// the process exits so the container stops billing; the hosted API wakes it
// again when a job is queued. Only successful empty polls count as idle — a
// failing claim (DB unreachable) must not read as a drained queue.
const IDLE_EXIT_MS = 60_000;
// Sustained claim failure: exit non-zero so the next wake retries with a
// fresh process instead of burning container time on a dead DB connection.
const FAIL_EXIT_MS = 5 * 60_000;
// The watcher's unconditional 1s row write doubles as a heartbeat (updatedAt).
// A "running" row this quiet lost its worker; sweep it back to the queue.
const STALE_RUNNING_MS = 60_000;
const SWEEP_EVERY_MS = 15_000;

interface ActiveJob {
  handle: RenderHandle;
  canceled: boolean;
  /** The row left "running" from under us (stale-swept back to queued after a
   * heartbeat gap): stop working it, write nothing, and keep its overlays for
   * whichever worker claims the retry. */
  lost: boolean;
}

const active = new Map<string, ActiveJob>();
let stopping = false;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Atomically claim the oldest queued job: the updateMany's state guard makes
 * exactly one worker win each row, so replicas never double-run a job. */
async function claimNext(): Promise<ClaimedJob | null> {
  const candidates = await prisma.cutRenderJob.findMany({
    where: { state: "queued" },
    orderBy: { createdAt: "asc" },
    take: 5,
    select: { id: true, userId: true, projectId: true, kind: true, spec: true, outName: true },
  });
  for (const c of candidates) {
    const { count } = await prisma.cutRenderJob.updateMany({
      where: { id: c.id, state: "queued" },
      data: { state: "running", claimedAt: new Date(), progress: 0, error: null },
    });
    if (count === 1) return c;
  }
  return null;
}

/** Requeue "running" rows whose heartbeat (updatedAt) has gone quiet: their
 * worker died without SIGTERM (OOM, host kill), so nothing else will ever
 * settle them. Own in-flight jobs are excluded by id. */
async function sweepStaleRunning(): Promise<void> {
  const { count } = await prisma.cutRenderJob.updateMany({
    where: {
      state: "running",
      updatedAt: { lt: new Date(Date.now() - STALE_RUNNING_MS) },
      id: { notIn: [...active.keys()] },
    },
    data: { state: "queued", claimedAt: null, progress: 0 },
  });
  if (count > 0) console.log(`[cut-worker] requeued ${count} stale running job(s)`);
}

/** Mirror one running job to its row every WATCH_MS: push the pipeline's
 * progress out, and pull cancellation in (a canceled — or deleted — row kills
 * the live ffmpeg; the run then settles without touching the row again). The
 * write happens every tick even when progress hasn't moved — it bumps
 * updatedAt, the heartbeat the stale-running sweep keys off. */
function watchJob(id: string, entry: ActiveJob): ReturnType<typeof setInterval> {
  return setInterval(() => {
    void (async () => {
      try {
        const row = await prisma.cutRenderJob.findUnique({
          where: { id },
          select: { state: true },
        });
        if (!row || row.state === "canceled") {
          entry.canceled = true;
          entry.handle.error = "Canceled.";
          entry.handle.proc?.kill("SIGKILL");
          return;
        }
        if (row.state !== "running") {
          entry.lost = true;
          entry.canceled = true; // suppress the run's own row writes
          entry.handle.error = "Requeued.";
          entry.handle.proc?.kill("SIGKILL");
          return;
        }
        await prisma.cutRenderJob.updateMany({
          where: { id, state: "running" },
          data: { progress: entry.handle.progress },
        });
      } catch {
        // Transient DB hiccup: keep watching; the run itself is unaffected.
      }
    })();
  }, WATCH_MS);
}

async function runJob(job: ClaimedJob): Promise<void> {
  const handle: RenderHandle = { tmpDir: "", outPath: "", progress: 0, log: [] };
  const entry: ActiveJob = { handle, canceled: false, lost: false };
  active.set(job.id, entry);
  const watcher = watchJob(job.id, entry);
  try {
    if (job.kind === "export" || job.kind === "preview" || job.kind === "card") {
      const { outputKey, outName } = await runExportJob(job, handle);
      await prisma.cutRenderJob.updateMany({
        where: { id: job.id, state: "running" },
        data: { state: "done", progress: 1, outputKey, outName },
      });
    } else if (job.kind === "import_url") {
      const result = await runImportUrlJob(job, () => entry.canceled);
      await prisma.cutRenderJob.updateMany({
        where: { id: job.id, state: "running" },
        data: { state: "done", progress: 1, result: result as unknown as Prisma.InputJsonValue },
      });
    } else {
      throw new Error(`Unknown job kind: ${job.kind}`);
    }
    console.log(`[cut-worker] ${job.kind} ${job.id} done`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A canceled job's row already says so; the running-state guard also
    // keeps this from resurrecting a row canceled between watcher ticks.
    if (!entry.canceled) {
      await prisma.cutRenderJob
        .updateMany({
          where: { id: job.id, state: "running" },
          data: { state: "error", error: message },
        })
        .catch(() => {});
    }
    console.error(`[cut-worker] ${job.kind} ${job.id} ${entry.canceled ? "canceled" : "failed"}: ${message}`);
  } finally {
    clearInterval(watcher);
    active.delete(job.id);
    // The overlay PNGs are single-use render inputs: delete them once the job
    // settles. A shutdown or stale-sweep requeues the job instead, so its
    // overlays must survive for the retry.
    if (!stopping && !entry.lost) await deleteObjects(overlayKeysOf(job));
  }
}

/** On shutdown, hand claimed work back: kill the live renders and requeue
 * their rows so the next worker picks them up instead of stranding them in
 * "running" forever. */
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log("[cut-worker] stopping…");
  for (const [id, entry] of active) {
    entry.canceled = true; // suppress the run's own error write
    entry.handle.proc?.kill("SIGKILL");
    await prisma.cutRenderJob
      .updateMany({
        where: { id, state: "running" },
        data: { state: "queued", claimedAt: null, progress: 0 },
      })
      .catch(() => {});
  }
  process.exit(0);
}

async function main(): Promise<void> {
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
  console.log(`[cut-worker] polling for jobs (max ${MAX_RUNNING} concurrent)`);
  const inFlight = new Set<Promise<void>>();
  let idleSince: number | null = null;
  let failingSince: number | null = null;
  let lastSweep = 0;
  while (!stopping) {
    if (inFlight.size >= MAX_RUNNING) {
      await Promise.race(inFlight);
      continue;
    }
    let job: ClaimedJob | null = null;
    try {
      if (Date.now() - lastSweep >= SWEEP_EVERY_MS) {
        lastSweep = Date.now();
        await sweepStaleRunning();
      }
      job = await claimNext();
      failingSince = null;
    } catch (err) {
      console.error("[cut-worker] claim failed:", err instanceof Error ? err.message : err);
      // A failing claim says nothing about the queue: keep the drain timer
      // from ticking, and give up with an error exit once the failure holds.
      idleSince = null;
      failingSince ??= Date.now();
      if (inFlight.size === 0 && Date.now() - failingSince >= FAIL_EXIT_MS) {
        console.error("[cut-worker] claims failing persistently; exiting");
        process.exit(1);
      }
      await sleep(IDLE_POLL_MS);
      continue;
    }
    if (!job) {
      if (inFlight.size === 0) {
        idleSince ??= Date.now();
        if (Date.now() - idleSince >= IDLE_EXIT_MS) {
          console.log("[cut-worker] queue drained; exiting");
          process.exit(0);
        }
      } else {
        idleSince = null;
      }
      await sleep(IDLE_POLL_MS);
      continue;
    }
    idleSince = null;
    const run = runJob(job).finally(() => inFlight.delete(run));
    inFlight.add(run);
  }
}

void main();
