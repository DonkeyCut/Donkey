import { expect, mock, test } from "bun:test";
import type { prisma } from "@/lib/prisma";
import { pointCardAt } from "./cardPointer";

// When the test project was last saved.
const SAVED = new Date(Date.UTC(2026, 10, 18, 6, 8));

function harness(newestJob = "job", counts = [1]) {
  const project = { previewKey: "old", updatedAt: SAVED };
  const updateMany = mock(async (args: unknown) => {
    void args;
    return { count: counts.shift() ?? 1 };
  });
  const tx = {
    cutProject: { findUnique: async () => project, updateMany },
    cutRenderJob: { findFirst: async () => ({ id: newestJob }) },
  };
  const db = {
    $transaction: (run: (t: typeof tx) => unknown) => run(tx),
  } as unknown as typeof prisma;
  return { db, updateMany };
}

const job = { id: "job", userId: "owner" };

test("a finished card leaves the project's edit time where the last save put it", async () => {
  const h = harness();
  await pointCardAt(job, "p", "new", h.db);
  expect(h.updateMany.mock.calls).toEqual([
    [
      {
        where: { id: "p", userId: "owner", previewKey: "old", updatedAt: SAVED },
        data: { previewKey: "new", updatedAt: SAVED },
      },
    ],
  ]);
});

test("a save landing under the write is read again", async () => {
  const h = harness("job", [0, 1]);
  await pointCardAt(job, "p", "new", h.db);
  expect(h.updateMany.mock.calls.length).toBe(2);
});

test("an older render never replaces a newer one's card", async () => {
  const h = harness("newer");
  await pointCardAt(job, "p", "new", h.db);
  expect(h.updateMany).not.toHaveBeenCalled();
});
