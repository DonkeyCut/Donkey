import { prisma } from "@/lib/prisma";

export { prisma };

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
  const prior = await prisma.cutMediaObject.findUnique({
    where: { r2Key: opts.r2Key },
    select: { bytes: true, uploadState: true },
  });
  const priorBytes = prior?.uploadState === "complete" ? prior.bytes : BigInt(0);
  const delta = BigInt(opts.bytes) - priorBytes;
  const [row] = await prisma.$transaction([
    prisma.cutMediaObject.upsert({
      where: { r2Key: opts.r2Key },
      create: {
        userId: opts.userId,
        projectId: opts.projectId,
        r2Key: opts.r2Key,
        fileName: opts.fileName,
        mime: opts.mime,
        bytes: BigInt(opts.bytes),
        kind: opts.kind,
        uploadState: "complete",
      },
      update: { bytes: BigInt(opts.bytes), uploadState: "complete" },
    }),
    prisma.cutStorageUsage.upsert({
      where: { userId: opts.userId },
      create: { userId: opts.userId, bytes: delta },
      update: { bytes: { increment: delta } },
    }),
  ]);
  return row.id;
}

/**
 * Undo registerObject for a job's staged files: drop the rows and hand the
 * bytes back to the user's storage total. R2 object deletion is the caller's
 * (best-effort) follow-up.
 */
export async function unregisterObjects(userId: string, r2Keys: string[]): Promise<void> {
  if (r2Keys.length === 0) return;
  const rows = await prisma.cutMediaObject.findMany({
    where: { userId, r2Key: { in: r2Keys } },
    select: { id: true, bytes: true, uploadState: true },
  });
  if (rows.length === 0) return;
  const bytes = rows.reduce(
    (sum, r) => (r.uploadState === "complete" ? sum + Number(r.bytes) : sum),
    0
  );
  await prisma.$transaction(async (tx) => {
    await tx.cutMediaObject.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    const usage = await tx.cutStorageUsage.findUnique({ where: { userId } });
    const next = Math.max(0, (usage ? Number(usage.bytes) : 0) - bytes);
    await tx.cutStorageUsage.upsert({
      where: { userId },
      create: { userId, bytes: BigInt(next) },
      update: { bytes: BigInt(next) },
    });
  });
}
