import { expect, mock, test } from "bun:test";
import { Prisma } from "@/generated/prisma/client";
import type { prisma } from "@/lib/prisma";
import { previewFromDoc, queuePreview } from "./previewJobs";

function harness() {
  const wake = mock(() => {});
  const tx = {
    cutRenderJob: {
      findFirst: mock(async (args: unknown) => { void args; return null as unknown; }),
      updateMany: mock(async (args: unknown) => { void args; return { count: 1 }; }),
      create: mock(async ({ data }: { data: unknown }) => ({ id: "new", state: "queued", data })),
    },
    cutMediaObject: { findUnique: mock(async () => null as unknown) },
  };
  const db = {
    settingOverride: { findUnique: async () => ({ value: { maxAttempts: 3 } }) },
    cutProject: { findFirst: mock(async (args: unknown) => { void args; return null as unknown; }) },
    $transaction: mock(async (run: (tx: unknown) => Promise<unknown>, options: unknown): Promise<unknown> => { void options; return run(tx); }),
  };
  return { tx, db, wake, deps: { db: db as unknown as typeof prisma, wake } };
}

test("available previews are reused without canceling or creating a job", async () => {
  const h = harness();
  h.tx.cutRenderJob.findFirst.mockResolvedValue({ id: "old", state: "done", outputKey: "key" });
  h.tx.cutMediaObject.findUnique.mockResolvedValue({ id: "media" });
  expect((await queuePreview("owner", "project", {}, "revision", h.deps)).id).toBe("old");
  expect(h.tx.cutRenderJob.create).not.toHaveBeenCalled();
  expect(h.tx.cutRenderJob.updateMany).not.toHaveBeenCalled();
  expect(h.wake).not.toHaveBeenCalled();
});

test("collected previews queue a new render and replace only this project's waiting job", async () => {
  const h = harness();
  h.tx.cutRenderJob.findFirst.mockResolvedValue({ id: "old", state: "done", outputKey: "collected" });
  expect((await queuePreview("owner", "project", { revision: "cloud:3" }, "cloud:3", h.deps)).id).toBe("new");
  expect(h.tx.cutRenderJob.updateMany.mock.calls[0][0]).toMatchObject({ where: { userId: "owner", projectId: "project", kind: "preview", state: "queued" } });
  expect(h.wake).toHaveBeenCalled();
});

test("serialization conflicts retry within the configured bound", async () => {
  const h = harness(); let attempts = 0;
  h.db.$transaction.mockImplementation(async (run) => {
    if (++attempts < 3) throw new Prisma.PrismaClientKnownRequestError("conflict", { code: "P2034", clientVersion: "test" });
    return run(h.tx);
  });
  await queuePreview("owner", "project", {}, "revision", h.deps);
  expect(attempts).toBe(3);
  expect(h.tx.cutRenderJob.create.mock.calls).toHaveLength(1);
});

test("remote preview captures the saved document and checks ownership", async () => {
  const h = harness();
  expect(await previewFromDoc("owner", "foreign", h.deps)).toBeNull();
  expect(h.db.$transaction).not.toHaveBeenCalled();
  h.db.cutProject.findFirst.mockResolvedValue({ doc: { clips: [{ id: "clip" }] }, version: 7 });
  await previewFromDoc("owner", "project", h.deps);
  expect(h.db.cutProject.findFirst.mock.calls[1][0]).toMatchObject({ where: { id: "project", userId: "owner" } });
  expect(h.tx.cutRenderJob.create.mock.calls[0][0]).toMatchObject({ data: { kind: "preview", spec: { revision: "cloud:7", fromDoc: { snapshot: { doc: { clips: [{ id: "clip" }] }, version: "7" } } } } });
});
