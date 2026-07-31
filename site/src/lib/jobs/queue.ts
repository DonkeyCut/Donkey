// The generic async-job queue: a request writes an AsyncJob row and publishes
// its id to the Cloudflare Queue, the queue's serial consumer (the Cut
// worker's queue handler) calls back into /api/jobs/worker one message at a
// time, and the creator polls the row. Mirrors the share-copy queue
// (src/cut/server/cloud/copyQueue.ts), which stays its own pipeline because it
// ships inside the Cut engine.
import { NextResponse } from "next/server";

import type { Prisma } from "@/generated/prisma/client";
import { JobFailure, jobKinds } from "@/lib/jobs/registry";
import { prisma } from "@/lib/prisma";

const JOBS_QUEUE_NAME = "donkey-jobs";
// A queued job untouched this long has likely lost its message (a failed
// publish, a dropped delivery) — the status poll re-publishes. Double delivery
// is safe: execution claims the row atomically.
const STALE_QUEUED_MS = 30_000;
// A running job untouched this long is a crashed or killed execution. The
// claim treats such a row as reclaimable so a queue retry can run it again,
// and the status poll surfaces it as an error instead of spinning forever.
const STALE_RUNNING_MS = 15 * 60_000;

type JobRow = NonNullable<Awaited<ReturnType<typeof prisma.asyncJob.findUnique>>>;

// --- Queue publish (Cloudflare Queues REST API; producers outside Workers
// publish over HTTP). The queue id is looked up from the name once per
// process. Missing credentials mean no queue (local dev): the request then
// executes the job before returning.

let cachedQueueId: string | null = null;

async function queueId(accountId: string, token: string): Promise<string | null> {
  if (cachedQueueId) return cachedQueueId;
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/queues`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    result?: { queue_id?: string; id?: string; queue_name?: string }[];
  };
  const q = body.result?.find((r) => r.queue_name === JOBS_QUEUE_NAME);
  cachedQueueId = q?.queue_id ?? q?.id ?? null;
  return cachedQueueId;
}

/** Publish one job id to the jobs queue; false when unconfigured or failed. */
async function publishJob(jobId: string): Promise<boolean> {
  const accountId = process.env.R2_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_QUEUES_API_TOKEN;
  if (!accountId || !token) return false;
  try {
    const id = await queueId(accountId, token);
    if (!id) return false;
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/queues/${id}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ body: { jobId }, content_type: "json" }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** Queue the job and hand back its id; without a queue (local dev) the job
 * runs now, before responding — a serverless response must not leave
 * fire-and-forget work behind. */
export async function enqueueJob(
  kind: string,
  payload: Prisma.InputJsonValue,
  createdBy: string,
): Promise<{ jobId: string }> {
  const job = await prisma.asyncJob.create({ data: { kind, payload, createdBy } });
  const queued = await publishJob(job.id);
  if (!queued) await executeJob(job.id);
  return { jobId: job.id };
}

/** Self-heal one polled row: a stale queued job re-publishes its message, and
 * a stale running job (crashed execution) becomes an error instead of spinning
 * the poller forever. Returns the row, refreshed when it changed. */
export async function healJob(job: JobRow): Promise<JobRow> {
  const idleMs = Date.now() - job.updatedAt.getTime();
  if (job.state === "queued" && idleMs > STALE_QUEUED_MS) {
    await publishJob(job.id);
  } else if (job.state === "running" && idleMs > STALE_RUNNING_MS) {
    await prisma.asyncJob.updateMany({
      where: { id: job.id, state: "running" },
      data: { state: "error", error: "The job stalled — try again." },
    });
    return (await prisma.asyncJob.findUnique({ where: { id: job.id } })) ?? job;
  }
  return job;
}

/** Report a job's state (healed first — see healJob). */
export async function jobStatusResponse(job: JobRow): Promise<Response> {
  job = await healJob(job);
  return NextResponse.json({
    kind: job.kind,
    state: job.state,
    result: job.result ?? undefined,
    error: job.error ?? undefined,
  });
}

/** Execute one job (called by the queue consumer through /api/jobs/worker).
 * A 200 consumes the message (including permanent failures, which land on the
 * job row); a 500 releases the claim and lets the queue retry. */
export async function executeJob(jobId: string): Promise<Response> {
  // A stale running row is a killed execution, so the claim takes it too —
  // that way the queue's redelivery actually re-runs it instead of ack'ing.
  const claimed = await prisma.asyncJob.updateMany({
    where: {
      id: jobId,
      OR: [
        { state: "queued" },
        { state: "running", updatedAt: { lt: new Date(Date.now() - STALE_RUNNING_MS) } },
      ],
    },
    data: { state: "running" },
  });
  // Already running, settled, or unknown — double delivery lands here.
  if (claimed.count === 0) return NextResponse.json({ ok: true });

  const fail = async (message: string) => {
    await prisma.asyncJob.update({
      where: { id: jobId },
      data: { state: "error", error: message },
    });
    return NextResponse.json({ ok: true });
  };

  const job = await prisma.asyncJob.findUnique({ where: { id: jobId } });
  if (!job) return NextResponse.json({ ok: true });
  const kind = jobKinds[job.kind];
  if (!kind) return fail(`Unknown job kind "${job.kind}".`);
  if (!kind.payload.safeParse(job.payload).success) {
    return fail("The stored job payload is invalid.");
  }

  try {
    const result = await kind.run(job.payload);
    await prisma.asyncJob.update({
      where: { id: jobId },
      data: { state: "done", result },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof JobFailure) return fail(e.message);
    // Transient failure: release the claim so the queue's retry can run the
    // job again from where its idempotent steps left off.
    await prisma.asyncJob
      .updateMany({ where: { id: jobId, state: "running" }, data: { state: "queued" } })
      .catch(() => {});
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Job failed." },
      { status: 500 },
    );
  }
}
