import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { graceState } from "./grace";
import { cutLimitsFor } from "./limits";

export async function usageBytes(userId: string): Promise<number> {
  const row = await prisma.cutStorageUsage.findUnique({ where: { userId } });
  return row ? Number(row.bytes) : 0;
}

/** How long a presigned claim holds its bytes. A claim older than this never
 * completed; the daily sweep drops it, and the quota stops counting it at the
 * same age so the two agree. */
export const PENDING_CLAIM_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Bytes claimed by presigns still in flight. A presign is a reservation: the
 * quota counts these alongside stored bytes, so a batch of uploads is held to
 * the cap as a whole and the check is not a race against the completes. */
export async function reservedBytes(userId: string): Promise<number> {
  const sum = await prisma.cutMediaObject.aggregate({
    _sum: { bytes: true },
    where: {
      userId,
      uploadState: "pending",
      quotaExempt: false,
      createdAt: { gte: new Date(Date.now() - PENDING_CLAIM_MAX_AGE_MS) },
    },
  });
  return Number(sum._sum.bytes ?? 0);
}

/** Adjust the user's stored-bytes counter inside the caller's transaction, so
 * it moves with the CutMediaObject rows it mirrors. Clamped at zero. */
export async function addUsage(tx: Prisma.TransactionClient, userId: string, delta: number) {
  const row = await tx.cutStorageUsage.findUnique({ where: { userId } });
  const next = Math.max(0, (row ? Number(row.bytes) : 0) + Math.round(delta));
  await tx.cutStorageUsage.upsert({
    where: { userId },
    create: { userId, bytes: BigInt(next) },
    update: { bytes: BigInt(next) },
  });
}

/** 413 when `incoming` more bytes would break the account's storage quota,
 * else null. Stored bytes and in-flight claims both count. Superusers are
 * unquotaed. `margin` widens the ceiling for a write
 * that gets something out rather than in (see EXPORT_QUOTA_MARGIN); the quota
 * the caller is told about stays the real one, so the wall reads the same
 * wherever it is raised. */
export async function quotaCheck(
  userId: string,
  incoming: number,
  margin = 1
): Promise<Response | null> {
  const limits = await cutLimitsFor(userId);
  if (limits.storageBytes === null) return null;
  const [stored, reserved] = await Promise.all([usageBytes(userId), reservedBytes(userId)]);
  const bytes = stored + reserved;
  if (bytes + incoming > limits.storageBytes * margin) {
    return Response.json(
      { error: "storage_quota_exceeded", bytes, quotaBytes: limits.storageBytes },
      { status: 413 }
    );
  }
  return null;
}

export const usageApi = {
  async get(userId: string) {
    const [bytes, limits] = await Promise.all([usageBytes(userId), cutLimitsFor(userId)]);
    const grace = await graceState(userId, bytes, limits);
    return Response.json({
      bytes,
      quotaBytes: limits.storageBytes,
      ...(grace && {
        grace: { deadline: grace.deadline.toISOString(), overBytes: grace.overBytes },
      }),
    });
  },
};
