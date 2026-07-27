import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { graceState } from "./grace";
import { cutLimitsFor } from "./limits";

export async function usageBytes(userId: string): Promise<number> {
  const row = await prisma.cutStorageUsage.findUnique({ where: { userId } });
  return row ? Number(row.bytes) : 0;
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
 * else null. Superusers are unquotaed. */
export async function quotaCheck(userId: string, incoming: number): Promise<Response | null> {
  const limits = await cutLimitsFor(userId);
  if (limits.storageBytes === null) return null;
  const bytes = await usageBytes(userId);
  if (bytes + incoming > limits.storageBytes) {
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
