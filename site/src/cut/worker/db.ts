import { adjustStorageBytes } from "../server/cloud/storageCounter";
import { artifactLifecycle, artifactUsageBytes } from "../lib/artifactPolicy";
import { cutLimitsFor, quotaMarginFor, storageCeiling } from "../server/cloud/limits";
import { STORAGE_FULL } from "../lib/operationFailure";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { resolveSettings } from "@/lib/config/resolve";

export { prisma };

/** A conflict rolls back every write; retry with a fresh transaction snapshot. */
export async function storageTransaction<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const override = await prisma.settingOverride.findUnique({
    where: { key: "cutStorageTransactions" }, select: { value: true },
  });
  const { maxAttempts } = resolveSettings(
    override ? { cutStorageTransactions: override.value } : {}, []
  ).settings.cutStorageTransactions;
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(run, { isolationLevel: "Serializable" });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2034" || attempt >= maxAttempts)
        throw error;
    }
  }
}

/** The columns a claimed CutRenderJob row hands the job runners. */
export interface ClaimedJob {
  id: string;
  userId: string;
  projectId: string | null;
  kind: string;
  spec: unknown;
  outName: string | null;
}

/** The kinds someone is watching happen: an export, a URL import, or a chat
 * turn has a progress surface on screen, while a hover proxy and a share card
 * are background polish nobody is waiting on. */
const WATCHED_KINDS = ["export", "import_url", "convert", "agent_turn"];

/** Atomically claim the next queued job: the updateMany's state guard makes
 * exactly one worker win each row, so replicas never double-run a job.
 *
 * Watched kinds go first, FIFO within a tier. Strict FIFO across all kinds let
 * a proxy render queued moments earlier hold up an export the user is staring
 * at — the wait was invisible in the UI, because the export's elapsed clock
 * only starts once it is claimed. */
export async function claimNextJob(): Promise<ClaimedJob | null> {
  // Editor command batches stay queued for the card that owns their document.
  for (const kind of [{ in: WATCHED_KINDS }, { in: ["preview", "card", "hls"] }]) {
    const candidates = await prisma.cutRenderJob.findMany({
      where: { state: "queued", kind },
      orderBy: { createdAt: "asc" },
      take: 10,
      select: { id: true, userId: true, projectId: true, kind: true, spec: true, outName: true },
    });
    for (const c of candidates) {
      const claimed = await prisma.$transaction(async (tx) => {
        if (["preview", "card", "hls"].includes(c.kind)) {
          const running = await tx.cutRenderJob.findFirst({
            where: { userId: c.userId, projectId: c.projectId, kind: c.kind, state: "running" },
            select: { id: true },
          });
          if (running) return null;
        }
        const updated = await tx.cutRenderJob.updateMany({
          where: { id: c.id, state: "queued" },
          data: { state: "running", claimedAt: new Date(), progress: 0, error: null },
        });
        if (updated.count !== 1) return null;
        return tx.cutRenderJob.findUnique({
          where: { id: c.id },
          select: { id: true, userId: true, projectId: true, kind: true, spec: true, outName: true },
        });
      }, { isolationLevel: "Serializable" });
      if (claimed) return claimed;
    }
  }
  return null;
}

/**
 * Record a finished R2 object and keep the user's storage total in step, and
 * hand back the row's id. The upsert makes re-registering the same key (a
 * preview re-render, a retried job) charge only the size delta instead of
 * double-counting.
 */
type ObjectRegistration = {
  userId: string;
  /** Null for objects no project owns — the account's shared library. */
  projectId: string | null;
  r2Key: string;
  fileName: string;
  mime: string;
  bytes: number;
  kind: string;
};

export async function registerObject(opts: ObjectRegistration): Promise<string> {
  return storageTransaction((tx) => registerObjectIn(tx, opts));
}

/** Register related files inside the transaction that publishes their asset. */
export async function registerObjectIn(tx: Prisma.TransactionClient, opts: ObjectRegistration): Promise<string> {
  const prior = await tx.cutMediaObject.findUnique({
    where: { r2Key: opts.r2Key },
    select: { bytes: true, uploadState: true, quotaExempt: true },
  });
  const quotaExempt = artifactLifecycle(opts.kind) !== "retained";
  const priorBytes = prior ? artifactUsageBytes(prior.bytes, prior.uploadState === "complete", prior.quotaExempt) : BigInt(0);
  const delta = artifactUsageBytes(BigInt(opts.bytes), true, quotaExempt) - priorBytes;
  // The wall every stored artifact meets, wherever it came from: a job that
  // grew past what its account can hold is failed here, at the moment the
  // bytes would be charged, instead of landing a row nothing can undo.
  if (delta > BigInt(0)) {
    const ceiling = storageCeiling(await cutLimitsFor(opts.userId), quotaMarginFor(opts.kind));
    if (ceiling !== null) {
      const usage = await tx.cutStorageUsage.findUnique({
        where: { userId: opts.userId },
        select: { bytes: true },
      });
      if ((usage?.bytes ?? BigInt(0)) + delta > BigInt(ceiling)) throw new Error(STORAGE_FULL);
    }
  }
  const row = await tx.cutMediaObject.upsert({
    where: { r2Key: opts.r2Key },
    create: { ...opts, bytes: BigInt(opts.bytes), quotaExempt, uploadState: "complete" },
    update: { bytes: BigInt(opts.bytes), uploadState: "complete", quotaExempt },
  });
  if (delta !== BigInt(0)) await adjustStorageBytes(tx, opts.userId, delta);
  return row.id;
}

/**
 * Undo registerObject for a job's staged files: drop the rows and hand the
 * bytes back to the user's storage total. R2 object deletion is the caller's
 * (best-effort) follow-up.
 */
export async function unregisterObjects(userId: string, r2Keys: string[]): Promise<void> {
  if (r2Keys.length === 0) return;
  await storageTransaction(async (tx) => {
    const rows = await tx.cutMediaObject.findMany({
      where: { userId, r2Key: { in: r2Keys } },
      select: { id: true, bytes: true, uploadState: true, quotaExempt: true },
    });
    if (rows.length === 0) return;
    const bytes = rows.reduce(
      (sum, row) => sum + artifactUsageBytes(row.bytes, row.uploadState === "complete", row.quotaExempt),
      BigInt(0)
    );
    await tx.cutMediaObject.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
    await adjustStorageBytes(tx, userId, -bytes);
  });
}
