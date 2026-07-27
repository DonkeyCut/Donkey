// Project-copy jobs: a viewer copying a share into their own account, and an
// owner duplicating their own project from the dashboard. A copy moves a
// whole project's worth of R2 objects, so it never runs in the request that
// asked for it: the request writes a CutCopyJob row and publishes its id to
// the Cloudflare Queue, the queue's serial consumer (the Cut worker's queue
// handler) calls back into /api/cut-copy-worker one message at a time, and
// the client polls the row. The serial consumer is the throttle — a burst of
// copy requests drains one copy at a time instead of stampeding R2 and the
// database all at once.
import { randomUUID } from "node:crypto";
import type { ProjectDoc } from "@/cut/lib/types";
import type { Prisma } from "@/generated/prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { copy, projectMediaKey } from "./r2";
import { normalizeEmails, normalizeFeatures } from "./share";
import { filterDocForShare, resolveShare, type ShareRow } from "./sharedView";
import { addUsage, quotaCheck } from "./usage";
import { caught, err } from "./util";

const COPY_QUEUE_NAME = "donkey-cut-copy";
// A queued job untouched this long has likely lost its message (a failed
// publish, a dropped delivery) — the status poll re-publishes, mirroring the
// render worker's self-healing wake. Double delivery is safe: execution
// claims the row atomically.
const STALE_QUEUED_MS = 30_000;
// A running job untouched this long is a crashed execution; surface the
// failure instead of spinning the viewer forever.
const STALE_RUNNING_MS = 10 * 60_000;

const QUOTA_MESSAGE =
  "Your cloud storage is full — free some space, then copy again.";

// --- Queue publish (Cloudflare Queues REST API; producers outside Workers
// publish over HTTP). The queue id is looked up from the name once per
// process. Missing credentials mean no queue (local dev): the request then
// executes the job before returning, which is the old inline behavior.

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
  const q = body.result?.find((r) => r.queue_name === COPY_QUEUE_NAME);
  cachedQueueId = q?.queue_id ?? q?.id ?? null;
  return cachedQueueId;
}

/** Publish one job id to the copy queue; false when unconfigured or failed. */
async function publishCopyJob(jobId: string): Promise<boolean> {
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
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

// --- What a copy would move. Shared by each request's fast quota check and
// the job's execution, which re-derives it at drain time.

type MediaRow = Awaited<ReturnType<typeof prisma.cutMediaObject.findMany>>[number];

/** Everything one copy materializes: the doc to store (already filtered for
 * shares, verbatim for duplicates), where it lands, and what it carries. */
interface CopySource {
  doc: ProjectDoc;
  name: string;
  folderId: string | null;
  media: MediaRow[];
  chats: { id: string; data: unknown }[];
  added: number;
}

function completeMedia(
  ownerId: string,
  projectId: string,
  fileNames?: string[]
): Promise<MediaRow[]> {
  return prisma.cutMediaObject.findMany({
    where: {
      userId: ownerId,
      projectId,
      kind: "media",
      uploadState: "complete",
      ...(fileNames ? { fileName: { in: fileNames } } : {}),
    },
  });
}

const mediaBytes = (media: MediaRow[]) => media.reduce((sum, m) => sum + Number(m.bytes), 0);

async function copyPlan(share: ShareRow) {
  const features = normalizeFeatures(share.features);
  const row = await prisma.cutProject.findFirst({
    where: { id: share.projectId, userId: share.userId },
  });
  if (!row) return null;
  const doc = filterDocForShare(row.doc as unknown as ProjectDoc, features);
  const media = await completeMedia(share.userId, share.projectId, doc.assets.map((a) => a.fileName));
  return { features, doc, media, added: mediaBytes(media) };
}

/** A share copy's source: access re-checked at drain time, doc filtered to
 * the shared surfaces, mid-flight brief-to-video runs dropped (the copy is
 * the viewer's project — a live plan would auto-resume on their account),
 * chats only when chat is shared. Returns the permanent-failure message when
 * the copy can no longer happen. */
async function shareSource(job: { shareId: string | null; userId: string }): Promise<CopySource | string> {
  const share = job.shareId
    ? await prisma.cutProjectShare.findUnique({ where: { id: job.shareId } })
    : null;
  if (!share) return "The share was removed.";
  if (!(await viewerAllowed(share, job.userId))) {
    return "You no longer have access to this project.";
  }
  const plan = await copyPlan(share);
  if (!plan) return "The project was deleted.";
  const chats = plan.features.chat
    ? await prisma.cutChatThread.findMany({
        where: { userId: share.userId, projectId: share.projectId },
        select: { id: true, data: true },
      })
    : [];
  const gv = plan.doc.genvideo;
  return {
    doc: {
      ...plan.doc,
      genvideo: gv && (gv.phase === "done" || gv.phase === "failed") ? gv : undefined,
    },
    name: plan.doc.name,
    folderId: null,
    media: plan.media,
    chats,
    added: plan.added,
  };
}

/** An owner duplicate's source: the whole doc, same folder, all its media, and
 * its conversations — chat-created media rides the doc and only its own thread
 * shows it, so a duplicate without the threads would hold media the owner can
 * neither see nor delete while it counts against their storage. A mid-flight
 * brief-to-video run is dropped, as on a share copy: a live plan on the
 * duplicate would resume and bill every shot a second time. */
async function duplicateSource(job: {
  projectId: string | null;
  userId: string;
}): Promise<CopySource | string> {
  const row = job.projectId
    ? await prisma.cutProject.findFirst({ where: { id: job.projectId, userId: job.userId } })
    : null;
  if (!row) return "The project was deleted.";
  const doc = row.doc as unknown as ProjectDoc;
  const media = await completeMedia(job.userId, row.id);
  const chats = await prisma.cutChatThread.findMany({
    where: { userId: job.userId, projectId: row.id },
    select: { id: true, data: true },
  });
  const gv = doc.genvideo;
  return {
    doc: {
      ...doc,
      genvideo: gv && (gv.phase === "done" || gv.phase === "failed") ? gv : undefined,
    },
    name: `${doc.name} copy`,
    folderId: row.folderId,
    media,
    chats,
    added: mediaBytes(media),
  };
}

/** Re-check the job's viewer against the share at execution time — access
 * revoked between request and drain cancels the copy. */
async function viewerAllowed(share: ShareRow, viewerId: string): Promise<boolean> {
  if (share.access === "public" || share.userId === viewerId) return true;
  const user = await prisma.user.findUnique({
    where: { id: viewerId },
    select: { email: true },
  });
  const email = user?.email?.toLowerCase() ?? "";
  return (normalizeEmails(share.emails) ?? []).includes(email);
}

/** Queue the job and hand back its id; without a queue (local dev) the job
 * runs now, before responding — a serverless response must not leave
 * fire-and-forget work behind. */
async function enqueue(data: {
  kind: "share" | "duplicate";
  shareId?: string;
  projectId?: string;
  userId: string;
}): Promise<Response> {
  const job = await prisma.cutCopyJob.create({ data });
  const queued = await publishCopyJob(job.id);
  if (!queued) await executeCopyJob(job.id);
  return Response.json({ jobId: job.id });
}

/** Report a job's state. Also the self-heal path: a stale queued job
 * re-publishes its message, and a stale running job (crashed execution)
 * reports failure instead of spinning the poller forever. */
async function statusResponse(job: NonNullable<Awaited<ReturnType<typeof prisma.cutCopyJob.findFirst>>>) {
  const idleMs = Date.now() - job.updatedAt.getTime();
  if (job.state === "queued" && idleMs > STALE_QUEUED_MS) {
    await publishCopyJob(job.id);
  } else if (job.state === "running" && idleMs > STALE_RUNNING_MS) {
    await prisma.cutCopyJob.updateMany({
      where: { id: job.id, state: "running" },
      data: { state: "error", error: "The copy stalled — try again." },
    });
    job = (await prisma.cutCopyJob.findUnique({ where: { id: job.id } })) ?? job;
  }
  return Response.json({
    state: job.state,
    newProjectId: job.newProjectId ?? undefined,
    error: job.error ?? undefined,
  });
}

export const copyJobs = {
  /** A viewer asks to copy a share: quota is pre-checked for fast feedback
   * (the job checks again authoritatively), then the job queues. */
  async request(token: string, req: Request) {
    try {
      const view = await resolveShare(token, req);
      if (view instanceof Response) return view;
      const session = await auth.api.getSession({ headers: req.headers });
      if (!session?.user) return err("Sign in to copy this project.", 401);
      const plan = await copyPlan(view.share);
      if (!plan) return err("Project not found.", 404);
      const over = await quotaCheck(session.user.id, plan.added);
      if (over) return over;
      return await enqueue({ kind: "share", shareId: view.share.id, userId: session.user.id });
    } catch (e) {
      return caught(e, "Could not copy the project.");
    }
  },

  /** An owner duplicates their own project from the dashboard — same queue,
   * same pacing; only the source differs. */
  async requestDuplicate(userId: string, projectId: string) {
    try {
      const row = await prisma.cutProject.findFirst({ where: { id: projectId, userId } });
      if (!row) return err("Project not found.", 404);
      const media = await completeMedia(userId, projectId);
      const over = await quotaCheck(userId, mediaBytes(media));
      if (over) return over;
      return await enqueue({ kind: "duplicate", projectId, userId });
    } catch (e) {
      return caught(e, "Could not duplicate the project.");
    }
  },

  /** Poll a share copy (public namespace: share access re-checked). */
  async status(token: string, jobId: string, req: Request) {
    const view = await resolveShare(token, req);
    if (view instanceof Response) return view;
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session?.user) return err("Sign in to copy this project.", 401);
    const job = await prisma.cutCopyJob.findFirst({
      where: { id: jobId, userId: session.user.id, shareId: view.share.id },
    });
    if (!job) return err("Copy not found.", 404);
    return statusResponse(job);
  },

  /** Poll any of the caller's own copy jobs (authed surface). */
  async ownerStatus(userId: string, jobId: string) {
    const job = await prisma.cutCopyJob.findFirst({ where: { id: jobId, userId } });
    if (!job) return err("Copy not found.", 404);
    return statusResponse(job);
  },
};

/** Execute one copy job (called by the queue consumer through
 * /api/cut-copy-worker). The kind picks the source — a share's filtered view
 * or the owner's own project — and the rest is one materialization path. A
 * 200 consumes the message (including permanent failures, which land on the
 * job row); a 500 releases the claim and lets the queue retry. */
export async function executeCopyJob(jobId: string): Promise<Response> {
  const claimed = await prisma.cutCopyJob.updateMany({
    where: { id: jobId, state: "queued" },
    data: { state: "running" },
  });
  // Already running, settled, or unknown — double delivery lands here.
  if (claimed.count === 0) return Response.json({ ok: true });

  const fail = async (message: string) => {
    await prisma.cutCopyJob.update({
      where: { id: jobId },
      data: { state: "error", error: message },
    });
    return Response.json({ ok: true });
  };

  try {
    const job = await prisma.cutCopyJob.findUnique({ where: { id: jobId } });
    if (!job) return Response.json({ ok: true });
    const src = job.kind === "duplicate" ? await duplicateSource(job) : await shareSource(job);
    if (typeof src === "string") return fail(src);
    const over = await quotaCheck(job.userId, src.added);
    if (over) return fail(QUOTA_MESSAGE);
    const now = Date.now();
    const copyDoc: ProjectDoc = { ...src.doc, name: src.name, createdAt: now, updatedAt: now };

    // The destination id is fixed up front and recorded before any bytes move,
    // so a retry reuses it: the R2 keys are the same, and the project create
    // below lands under the same id instead of minting a second project.
    const newProjectId = job.newProjectId ?? randomUUID();
    if (!job.newProjectId) {
      await prisma.cutCopyJob.update({ where: { id: jobId }, data: { newProjectId } });
    }

    // R2 copies run before the transaction (network I/O can't sit inside one)
    // but are idempotent: same source to the same deterministic destination
    // key, so a redelivery just overwrites with identical bytes.
    for (const m of src.media) {
      await copy(m.r2Key, projectMediaKey(job.userId, newProjectId, m.fileName));
    }

    // One transaction for every row and the usage counter AND the job's
    // terminal state. Because the claim above requires state=queued and this
    // commit flips it to done atomically, the whole body commits at most once:
    // addUsage never double-counts, a failure rolls the project back (no
    // orphan row), and a retry re-runs from a clean slate. Only already-copied
    // R2 bytes can linger on a permanent failure, and those are GC-collectible
    // under a projectId no row references.
    await prisma.$transaction(async (tx) => {
      await tx.cutProject.create({
        data: {
          id: newProjectId,
          userId: job.userId,
          name: copyDoc.name,
          doc: copyDoc as unknown as Prisma.InputJsonValue,
          folderId: src.folderId,
        },
      });
      if (src.media.length > 0) {
        await tx.cutMediaObject.createMany({
          data: src.media.map((m) => ({
            userId: job.userId,
            projectId: newProjectId,
            r2Key: projectMediaKey(job.userId, newProjectId, m.fileName),
            fileName: m.fileName,
            mime: m.mime,
            bytes: m.bytes,
            kind: "media",
            uploadState: "complete",
          })),
        });
      }
      if (src.chats.length > 0) {
        // Thread ids are client-generated and keyed (projectId, id), so the
        // copies keep their ids under the new project.
        await tx.cutChatThread.createMany({
          data: src.chats.map((c) => ({
            projectId: newProjectId,
            id: c.id,
            userId: job.userId,
            data: c.data as Prisma.InputJsonValue,
          })),
        });
      }
      await addUsage(tx, job.userId, src.added);
      await tx.cutCopyJob.update({
        where: { id: jobId },
        data: { state: "done", newProjectId },
      });
    });
    return Response.json({ ok: true });
  } catch (e) {
    // Transient failure (database or R2 hiccup): release the claim so the
    // queue's retry can run the job again. The recorded newProjectId makes the
    // retry reuse the same destination.
    await prisma.cutCopyJob
      .updateMany({ where: { id: jobId, state: "running" }, data: { state: "queued" } })
      .catch(() => {});
    return err(e instanceof Error ? e.message : "Copy failed.", 500);
  }
}
