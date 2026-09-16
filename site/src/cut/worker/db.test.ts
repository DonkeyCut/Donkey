import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Prisma } from "@/generated/prisma/client";
import { prisma as actualPrisma } from "@/lib/prisma";

const originalPrisma = actualPrisma;
const prisma = {
  settingOverride: { findUnique: mock(async () => ({ value: { maxAttempts: 3 } })) },
  $transaction: mock(async (
  run: (tx: Prisma.TransactionClient) => Promise<unknown>,
  options: { isolationLevel: string },
): Promise<unknown> => {
  void run; void options;
  throw new Error("Unexpected transaction");
}) };
mock.module("@/lib/prisma", () => ({ prisma }));
const { registerObject, unregisterObjects } = await import("./db");
afterAll(() => { mock.module("@/lib/prisma", () => ({ prisma: originalPrisma })); });

const conflict = () => new Prisma.PrismaClientKnownRequestError("Write conflict", {
  code: "P2034", clientVersion: "test",
});
const object = {
  id: "object", userId: "user", projectId: "project", r2Key: "cut/user/file.mp4",
  fileName: "file.mp4", mime: "video/mp4", bytes: BigInt(40), kind: "export",
  uploadState: "complete", quotaExempt: false,
};
const input = { ...object, bytes: 100 };
const restores: (() => void)[] = [];
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); });

function harness(failures = 1, error: Error = conflict()) {
  let stored: typeof object | null = { ...object };
  let usage = BigInt(140); // Includes another 100 bytes belonging to the account.
  let attempts = 0;
  const transaction = prisma.$transaction.mockImplementation((async (
    run: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) => {
    attempts++;
    let pending = stored ? { ...stored } : null;
    let pendingUsage = usage;
    const tx = {
      cutMediaObject: {
        findUnique: async () => pending,
        findMany: async () => pending ? [pending] : [],
        upsert: async ({ update }: { update: Partial<typeof object> }) => {
          pending = { ...object, ...pending, ...update };
          return pending;
        },
        deleteMany: async () => { pending = null; return { count: 1 }; },
      },
      cutStorageUsage: {
        upsert: async () => ({ userId: "user", bytes: pendingUsage }),
        updateMany: async ({ where, data }: {
          where: { bytes: bigint }; data: { bytes: { increment: bigint } };
        }) => {
          if (where.bytes !== pendingUsage) return { count: 0 };
          pendingUsage += data.bytes.increment;
          return { count: 1 };
        },
      },
    };
    const result = await run(tx as unknown as Prisma.TransactionClient);
    if (attempts <= failures) {
      // The conflicting writer commits a different object size. The retry
      // must reread it and recompute the delta after this attempt rolls back.
      if (stored) { stored = { ...stored, bytes: stored.bytes + BigInt(10) }; usage += BigInt(10); }
      throw error;
    }
    stored = pending;
    usage = pendingUsage;
    return result;
  }));
  restores.push(() => transaction.mockRestore());
  return { transaction, state: () => ({ stored, usage, attempts }) };
}

test("registration retries the whole transaction and charges the fresh size delta once", async () => {
  const h = harness();
  expect(await registerObject(input)).toBe("object");
  expect(h.state()).toMatchObject({ attempts: 2, usage: BigInt(200), stored: { bytes: BigInt(100) } });
  for (const call of h.transaction.mock.calls) expect(call[1]).toEqual({ isolationLevel: "Serializable" });
});

test("unregistration retries and refunds the freshly read bytes once", async () => {
  const h = harness();
  await unregisterObjects("user", [object.r2Key]);
  expect(h.state()).toEqual({ attempts: 2, usage: BigInt(100), stored: null });
});

test("conflicts stop at the configured attempt limit", async () => {
  const error = conflict();
  const h = harness(10, error);
  await expect(registerObject(input)).rejects.toBe(error);
  expect(h.state().attempts).toBe(3);
});

test("other failures propagate without retrying", async () => {
  const error = new Error("Database unavailable");
  const h = harness(1, error);
  await expect(registerObject(input)).rejects.toBe(error);
  expect(h.state().attempts).toBe(1);
});
