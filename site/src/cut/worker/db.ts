import { adjustStorageBytes } from "../server/cloud/storageCounter";
import { artifactLifecycle, artifactUsageBytes } from "../lib/artifactPolicy";
import { cutLimitsFor, quotaMarginFor, storageCeiling } from "../server/cloud/limits";
import { STORAGE_FULL } from "../lib/operationFailure";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { resolveSettings } from "@/lib/config/resolve";

export { prisma };

/** A conflict rolls back every write; retry with a fresh transaction snapshot. */
async function storageTransaction<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
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

/**
 * Record a finished R2 object and keep the user's storage total in step, and
 * hand back the row's id. The upsert makes re-registering the same key (a
 * preview re-render, a retried job) charge only the size delta instead of
 * double-counting.
 */
export async function registerObject(opts: {
  userId: string;
  /** Null for objects no project owns — the account's shared library. */
  projectId: string | null;
  r2Key: string;
  fileName: string;
  mime: string;
  bytes: number;
  kind: string;
}): Promise<string> {
  return storageTransaction(async (tx) => {
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
  });
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
