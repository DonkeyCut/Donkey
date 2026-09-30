import { beforeEach, expect, mock, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";

// A copy carries each master's preview proxy under the name the doc's asset
// holds, quota-exempt. A proxy with no complete object comes off its asset, so
// the copy builds a fresh one on open.
type Obj = { fileName: string; kind: string; r2Key: string; mime: string; bytes: bigint; uploadState: string };
const objects: Obj[] = [];
const created: Record<string, unknown>[] = [];
const copied: [string, string][] = [];
let savedDoc: { assets: { fileName: string; proxy?: { fileName: string } }[] } | null = null;
const job = { id: "j", kind: "duplicate", projectId: "p", userId: "u", shareId: null, newProjectId: "n", state: "queued" };
const project = {
  id: "p",
  userId: "u",
  folderId: null,
  doc: {
    name: "Cut",
    assets: [
      { id: "a", fileName: "log.mov", type: "video", duration: 1, proxy: { fileName: "log.proxy.mp4", sizeBytes: 3 } },
      { id: "b", fileName: "raw.mov", type: "video", duration: 1, proxy: { fileName: "raw.proxy.mp4", sizeBytes: 3 } },
    ],
    clips: [],
  },
};
const matches = (o: Obj, where: { kind?: string; fileName?: { in: string[] } }) =>
  (!where.kind || o.kind === where.kind) && (!where.fileName || where.fileName.in.includes(o.fileName));
const tx = {
  cutProject: { create: mock(async ({ data }: { data: { doc: typeof savedDoc } }) => { savedDoc = data.doc; return {}; }) },
  cutMediaObject: { createMany: mock(async ({ data }: { data: Record<string, unknown>[] }) => { created.push(...data); return { count: data.length }; }) },
  cutChatThread: { createMany: mock(async () => ({ count: 0 })) },
  cutCopyJob: { update: mock(async () => ({})) },
};
const prisma = {
  cutCopyJob: {
    updateMany: mock(async () => ({ count: 1 })),
    findUnique: mock(async () => job),
    update: mock(async () => ({})),
  },
  cutProject: { findFirst: mock(async () => project) },
  cutMediaObject: { findMany: mock(async ({ where }: { where: Parameters<typeof matches>[1] }) => objects.filter((o) => matches(o, where))) },
  cutChatThread: { findMany: mock(async () => []) },
  $transaction: mock(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
};
await stubModule<typeof import("@/lib/prisma")>("@/lib/prisma", import.meta.url, { prisma: prisma as never });
await stubModule<typeof import("./r2")>("./r2", import.meta.url, {
  copy: (async (from: string, to: string) => { copied.push([from, to]); }) as never,
  projectMediaKey: ((userId: string, projectId: string, fileName: string) => `cut/${userId}/${projectId}/${fileName}`) as never,
});
const added: number[] = [];
await stubModule<typeof import("./usage")>("./usage", import.meta.url, {
  quotaCheck: (async () => null) as never,
  addUsage: (async (_tx: unknown, _user: string, delta: number) => { added.push(delta); }) as never,
});
const { executeCopyJob } = await import("./copyQueue");

const obj = (fileName: string, kind: string, bytes: number): Obj =>
  ({ fileName, kind, r2Key: `cut/u/p/${fileName}`, mime: "video/mp4", bytes: BigInt(bytes), uploadState: "complete" });

beforeEach(() => {
  objects.splice(0, objects.length, obj("log.mov", "media", 100), obj("raw.mov", "media", 50), obj("log.proxy.mp4", "proxy", 7));
  created.splice(0);
  copied.splice(0);
  added.splice(0);
  savedDoc = null;
});

test("a duplicate copies each built proxy beside its master, quota-exempt", async () => {
  expect((await executeCopyJob("j")).status).toBe(200);
  expect(copied.filter(([from]) => from.endsWith(".proxy.mp4"))).toEqual([["cut/u/p/log.proxy.mp4", "cut/u/n/log.proxy.mp4"]]);
  expect(created.find((r) => r.fileName === "log.proxy.mp4")).toMatchObject({
    kind: "proxy",
    quotaExempt: true,
    projectId: "n",
    r2Key: "cut/u/n/log.proxy.mp4",
  });
  // Only the masters count toward the new owner's storage.
  expect(added).toEqual([150]);
  expect(savedDoc?.assets.find((a) => a.fileName === "log.mov")?.proxy?.fileName).toBe("log.proxy.mp4");
});

test("an asset whose proxy object is missing lands without one", async () => {
  await executeCopyJob("j");
  expect(savedDoc?.assets.find((a) => a.fileName === "raw.mov")?.proxy).toBeUndefined();
  expect(created.some((r) => r.fileName === "raw.proxy.mp4")).toBe(false);
});
