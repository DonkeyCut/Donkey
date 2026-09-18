import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Prisma } from "@/generated/prisma/client";
import { prisma as actualPrisma } from "@/lib/prisma";

const originalPrisma = actualPrisma;
// The account the charge point weighs every object against: free tier, no Pro.
const prisma = {
  settingOverride: { findUnique: mock(async () => ({ value: { maxAttempts: 3 } })) },
  user: { findUnique: mock(async () => ({ superUser: false })) },
  proSubscription: { findUnique: mock(async () => null) },
  $transaction: mock(async (
  run: (tx: Prisma.TransactionClient) => Promise<unknown>,
  options: { isolationLevel: string },
): Promise<unknown> => {
  void run; void options;
  throw new Error("Unexpected transaction");
}) };
mock.module("@/lib/prisma", () => ({ prisma }));
const { registerObject, unregisterObjects } = await import("./db");
const { FREE_STORAGE_BYTES } = await import("../server/cloud/limits");
const { STORAGE_FULL } = await import("../lib/operationFailure");
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
        findUnique: async () => ({ userId: "user", bytes: pendingUsage }),
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

test("an object that would break the account's storage ceiling is refused, uncharged", async () => {
  const h = harness(0);
  await expect(registerObject({ ...input, bytes: FREE_STORAGE_BYTES * 2 })).rejects.toThrow(STORAGE_FULL);
  expect(h.state()).toMatchObject({ usage: BigInt(140), stored: { bytes: BigInt(40) } });
});

test("an export renders into the margin past the account's quota", async () => {
  const h = harness(0);
  expect(await registerObject({ ...input, bytes: Math.floor(FREE_STORAGE_BYTES * 1.1) })).toBe("object");
  expect(h.state().stored).toMatchObject({ bytes: BigInt(Math.floor(FREE_STORAGE_BYTES * 1.1)) });
});

test("the margin is the export's alone: the same bytes coming in meet the quota", async () => {
  const h = harness(0);
  await expect(
    registerObject({ ...input, kind: "media", bytes: Math.floor(FREE_STORAGE_BYTES * 1.1) })
  ).rejects.toThrow(STORAGE_FULL);
  expect(h.state()).toMatchObject({ usage: BigInt(140), stored: { bytes: BigInt(40) } });
});

test("a re-registration that shrinks the object is charged its delta", async () => {
  const h = harness(0);
  expect(await registerObject({ ...input, bytes: 10 })).toBe("object");
  expect(h.state()).toMatchObject({ usage: BigInt(110), stored: { bytes: BigInt(10) } });
});
