import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";

// The key a deleted account leaves behind. better-auth lowercases every
// address it stores, so the same Google account hashes the same on its way
// back in.
export function deletedAccountKey(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

/** Whether an account under this address was deleted before. */
export async function isDeletedAddress(email: string): Promise<boolean> {
  const row = await prisma.deletedAccount.findUnique({
    where: { emailHash: deletedAccountKey(email) },
    select: { emailHash: true },
  });
  return row !== null;
}
