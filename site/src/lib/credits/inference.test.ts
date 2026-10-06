import { describe, expect, test } from "bun:test";

import { Prisma } from "@/generated/prisma/client";
import { stubModule } from "@/lib/testing/stubModule";

// A charge is one Serializable transaction on the account. Concurrent charges
// for one account conflict, and Postgres reports it two ways: Prisma's P2034,
// or the driver adapter's raw TransactionWriteConflict at commit.

const recorded = { creditCostMicros: BigInt(0), remainingBalanceMicros: BigInt(0), usageEventId: "event" };
let failures: Error[] = [];
let attempts = 0;
const prisma = {
  $transaction: async () => {
    attempts += 1;
    const failure = failures.shift();
    if (failure) {
      throw failure;
    }
    return recorded;
  },
};

await stubModule<typeof import("@/lib/prisma")>("@/lib/prisma", import.meta.url, { prisma: prisma as never });
const { recordInferenceUsage } = await import("./inference");

const usage = {
  clientId: null,
  model: "model",
  provider: "provider",
  requestKind: "judge",
  route: "/api/inference/judge/",
  status: "failed",
  userId: "user",
} as const;

const knownConflict = () =>
  new Prisma.PrismaClientKnownRequestError("write conflict", { code: "P2034", clientVersion: "test" });

// The shape @prisma/driver-adapter-utils throws when the conflict lands on COMMIT.
const adapterConflict = () =>
  Object.assign(new Error("TransactionWriteConflict"), {
    name: "DriverAdapterError",
    cause: { kind: "TransactionWriteConflict", originalCode: "40001" },
  });

describe("recording usage under concurrent charges", () => {
  test("retries a conflict raised at commit by the driver adapter", async () => {
    failures = [adapterConflict()];
    attempts = 0;
    expect(await recordInferenceUsage(usage)).toEqual(recorded);
    expect(attempts).toBe(2);
  });

  test("outlasts a burst of conflicts from parallel judge calls", async () => {
    failures = Array.from({ length: 8 }, (_, i) => (i % 2 ? knownConflict() : adapterConflict()));
    attempts = 0;
    expect(await recordInferenceUsage(usage)).toEqual(recorded);
    expect(attempts).toBe(9);
  });

  test("throws any other error at once", async () => {
    const other = new Error("connection refused");
    failures = [other];
    attempts = 0;
    await expect(recordInferenceUsage(usage)).rejects.toBe(other);
    expect(attempts).toBe(1);
  });
});
