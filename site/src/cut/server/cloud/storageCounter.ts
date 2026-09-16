import type { Prisma } from "@/generated/prisma/client";

/** Called inside a transaction. The upsert locks the account row until commit. */
export async function adjustStorageBytes(tx: Prisma.TransactionClient, userId: string, delta: bigint): Promise<void> {
  const row = await tx.cutStorageUsage.upsert({
    where: { userId },
    create: { userId, bytes: BigInt(0) },
    update: { userId },
  });
  const increment = delta < -row.bytes ? -row.bytes : delta;
  const changed = await tx.cutStorageUsage.updateMany({
    where: { userId, bytes: row.bytes },
    data: { bytes: { increment } },
  });
  if (changed.count !== 1) throw new Error("Storage usage changed during the operation.");
}
