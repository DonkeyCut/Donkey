import { describe, expect, test } from "bun:test";

import { Prisma } from "@/generated/prisma/client";
import { stubModule } from "@/lib/testing/stubModule";

// A charge is one Serializable transaction on the account. Concurrent charges
// for one account conflict, and Postgres reports it two ways: Prisma's P2034,
// or the driver adapter's raw TransactionWriteConflict at commit.

const recorded = { creditCostMicros: BigInt(0), remainingBalanceMicros: BigInt(0), usageEventId: "event" };
let failures: Error[] = [];
let attempts = 0;
let upserts = 0;
let account: { balanceMicros: bigint; lifetimeChargedMicros: bigint; lifetimeGrantedMicros: bigint } | null = null;
let lapsedMicros: bigint | null = null;
const prisma = {
  $transaction: async () => {
    attempts += 1;
    const failure = failures.shift();
    if (failure) {
      throw failure;
    }
    return recorded;
  },
  userCreditAccount: {
    findUnique: async () => account,
    findUniqueOrThrow: async () => account,
    upsert: async () => {
      upserts += 1;
      return account;
    },
  },
  userCreditGrant: {
    aggregate: async () => ({ _sum: { remainingAmountMicros: lapsedMicros } }),
    findMany: async () => [],
  },
  userCreditLimit: { findMany: async () => [] },
  inferenceUsageEvent: { findMany: async () => [] },
};

await stubModule<typeof import("@/lib/prisma")>("@/lib/prisma", import.meta.url, { prisma: prisma as never });
const { getCreditBalance, recordInferenceUsage } = await import("./inference");

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

// The balance is polled by every open editor, so the read never writes: credit
// past its expiry is netted out here and retired by the next charge.
describe("reading the balance", () => {
  test("nets out lapsed grants without writing", async () => {
    account = { balanceMicros: BigInt(5_000_000), lifetimeChargedMicros: BigInt(0), lifetimeGrantedMicros: BigInt(5_000_000) };
    lapsedMicros = BigInt(2_000_000);
    attempts = 0;
    upserts = 0;
    const balance = await getCreditBalance("user");
    expect(balance.balanceMicros).toBe("3000000");
    expect(attempts).toBe(0);
    expect(upserts).toBe(0);
  });

  test("an account without a row reads as empty", async () => {
    account = null;
    lapsedMicros = null;
    upserts = 0;
    const balance = await getCreditBalance("user");
    expect(balance.balanceMicros).toBe("0");
    expect(upserts).toBe(0);
  });
});
