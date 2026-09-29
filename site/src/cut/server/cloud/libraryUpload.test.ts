import { expect, mock, test } from "bun:test";
import { prisma } from "@/lib/prisma";
import { createLibraryUploadPreparation } from "./libraryUpload";

function harness() {
  const object = { id: "object", userId: "owner", fileName: "phone.mov", bytes: BigInt(10), r2Key: "cut/owner/library/phone.mov", kind: "library", projectId: null, mime: "video/quicktime", uploadState: "pending", quotaExempt: false, createdAt: new Date(), updatedAt: new Date() };
  const source = mock(async (args: unknown) => { void args; return object as typeof object | null; });
  const asset = mock(async () => null);
  const folder = mock(async () => null);
  const existing = mock(async () => null as { id: string; state: string } | null);
  const create = mock(async (args: unknown) => { void args; return { id: "library-upload-object" }; });
  const reset = mock(async (args: unknown) => { void args; return { count: 1 }; });
  const head = mock(async () => ({ bytes: 10, mime: "video/quicktime", etag: "tag" }));
  const gate = mock(async () => null);
  const start = mock(() => {});
  const db = {
    cutMediaObject: { findFirst: source }, cutLibraryAsset: { findFirst: asset },
    cutFolder: { findFirst: folder }, cutRenderJob: { findFirst: existing, upsert: create, updateMany: reset },
  } as unknown as typeof prisma;
  const prepare = createLibraryUploadPreparation({ db, inspect: head, checkLimit: gate, wake: start });
  return { prepare, object, source, asset, folder, existing, create, reset, head, gate, start };
}
const req = (data: unknown = { key: "cut/owner/library/phone.mov", name: "phone.mov" }) => new Request("https://donkeycut.com/api/cut-cloud/library/prepare", { method: "POST", body: JSON.stringify(data) });

test("preparation verifies upload ownership before touching storage", async () => {
  const h = harness();
  h.source.mockResolvedValue(null);
  expect((await h.prepare("stranger", req())).status).toBe(404);
  expect(h.source.mock.calls[0]?.[0]).toMatchObject({ where: { userId: "stranger", kind: "library", projectId: null } });
  expect(h.head).not.toHaveBeenCalled();
  expect(h.create).not.toHaveBeenCalled();
});

test("preparation refuses invalid bodies, foreign folders and incomplete uploads", async () => {
  const h = harness();
  expect((await h.prepare("owner", req({ key: 3 }))).status).toBe(400);
  expect((await h.prepare("owner", req({ key: h.object.r2Key, name: "phone.mov", folderId: "foreign" }))).status).toBe(404);
  h.head.mockResolvedValue({ bytes: 9, mime: "video/quicktime", etag: "tag" });
  expect((await h.prepare("owner", req())).status).toBe(400);
  expect(h.create).not.toHaveBeenCalled();
});

test("preparation queues one deterministic conversion for the stored original", async () => {
  const h = harness();
  expect(await (await h.prepare("owner", req())).json()).toEqual({ jobId: "library-upload-object" });
  expect(h.create.mock.calls[0]?.[0]).toMatchObject({ where: { id: "library-upload-object" }, create: { userId: "owner", kind: "convert", spec: { target: "library", key: h.object.r2Key } } });
  expect(h.start.mock.calls.length).toBe(1);
});

test("preparation cannot take ownership of an existing Library asset's file", async () => {
  const h = harness();
  h.object.uploadState = "complete";
  expect((await h.prepare("owner", req())).status).toBe(409);
  expect(h.create).not.toHaveBeenCalled();
  expect(h.head).not.toHaveBeenCalled();
});

test("retrying active work returns the same job without a new upload or quota charge", async () => {
  const h = harness();
  h.existing.mockResolvedValue({ id: "library-upload-object", state: "running" } as never);
  expect(await (await h.prepare("owner", req())).json()).toEqual({ jobId: "library-upload-object" });
  expect(h.create).not.toHaveBeenCalled();
  expect(h.gate).not.toHaveBeenCalled();
  expect(h.head).not.toHaveBeenCalled();
});

test("worker failure can be retried under the same job id", async () => {
  const h = harness();
  h.existing.mockResolvedValue({ id: "library-upload-object", state: "error" } as never);
  expect((await h.prepare("owner", req())).status).toBe(200);
  expect(h.reset.mock.calls[0]?.[0]).toMatchObject({ where: { id: "library-upload-object", userId: "owner" }, data: { state: "queued", error: null } });
});
