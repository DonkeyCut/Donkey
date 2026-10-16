import { beforeEach, expect, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";

// One network gets `limit` signup grants per window. The fake table applies
// each guarded write the way Postgres does: the where clause decides whether
// the row changes, and the count says whether it did.
type Row = { networkKey: string; windowStart: Date; claims: number };
type Where = { networkKey: string; windowStart?: { lt: Date }; claims?: { lt: number } };
const rows = new Map<string, Row>();

function matches(row: Row | undefined, where: Where): row is Row {
  if (!row) {
    return false;
  }
  if (where.windowStart && !(row.windowStart < where.windowStart.lt)) {
    return false;
  }
  return !where.claims || row.claims < where.claims.lt;
}

const prisma = {
  signupNetwork: {
    createMany: async ({ data }: { data: Row[] }) => {
      const fresh = data.filter((row) => !rows.has(row.networkKey));
      for (const row of fresh) {
        rows.set(row.networkKey, { ...row });
      }
      return { count: fresh.length };
    },
    updateMany: async ({ where, data }: { where: Where; data: { windowStart?: Date; claims: number | { increment: number } } }) => {
      const row = rows.get(where.networkKey);
      if (!matches(row, where)) {
        return { count: 0 };
      }
      row.claims = typeof data.claims === "number" ? data.claims : row.claims + data.claims.increment;
      row.windowStart = data.windowStart ?? row.windowStart;
      return { count: 1 };
    },
  },
};
await stubModule<typeof import("@/lib/prisma")>("@/lib/prisma", import.meta.url, { prisma: prisma as never });
process.env.BETTER_AUTH_SECRET ??= "test-secret";

const { claimSignupGrant, signupNetworkKey } = await import("./signup-network");

const CAP = { limit: 3, windowDays: 7 };
const DAY_MS = 24 * 60 * 60 * 1000;
const start = new Date("2026-10-12T11:00:00Z");

function from(ip: string): Headers {
  return new Headers({ "x-forwarded-for": `${ip}, 10.0.0.1` });
}

beforeEach(() => {
  rows.clear();
});

test("a network past its limit gets no more grants inside the window", async () => {
  const key = signupNetworkKey(from("2804:14c:4e7:85e6:6499:71e4:d97d:a236"));
  if (!key) {
    throw new Error("no key");
  }
  const granted = [];
  for (let i = 0; i < 14; i++) {
    granted.push(await claimSignupGrant(key, CAP, new Date(start.getTime() + i * 60_000)));
  }
  expect(granted.filter(Boolean)).toHaveLength(3);
  expect(granted.slice(0, 3)).toEqual([true, true, true]);
});

test("the window starts over once it lapses", async () => {
  const key = "network";
  for (let i = 0; i < 4; i++) {
    await claimSignupGrant(key, CAP, start);
  }
  expect(await claimSignupGrant(key, CAP, new Date(start.getTime() + 6 * DAY_MS))).toBe(false);
  expect(await claimSignupGrant(key, CAP, new Date(start.getTime() + 8 * DAY_MS))).toBe(true);
});

test("addresses inside one IPv6 /64 share a key, and the key hides the address", () => {
  const a = signupNetworkKey(from("2804:14c:4e7:85e6:6499:71e4:d97d:a236"));
  const b = signupNetworkKey(from("2804:14c:4e7:85e6::1"));
  const other = signupNetworkKey(from("2804:14c:4e7:85e7::1"));
  expect(a).toBe(b);
  expect(a).not.toBe(other);
  expect(a).not.toContain("2804");
  expect(signupNetworkKey(from("203.0.113.7"))).not.toBe(signupNetworkKey(from("203.0.113.8")));
});

test("a request without a readable address has no key", () => {
  expect(signupNetworkKey(new Headers())).toBeNull();
  expect(signupNetworkKey(from("not-an-ip"))).toBeNull();
});
