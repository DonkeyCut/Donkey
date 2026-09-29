import { describe, expect, mock, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { runLibraryUploadJob } from "./libraryUploadJob";
import type { LibraryAsset } from "@/cut/server/library";

function harness() {
  const source = { id: "original", fileName: "phone.mov", userId: "owner", r2Key: "cut/owner/library/phone.mov", bytes: BigInt(8), mime: "video/quicktime" };
  const sourceRead = mock(async (args: unknown) => { void args; return source; });
  const prior = mock(async () => null as null | { id: string; userId: string; mediaObjectId: string; deletedAt: Date | null; folderId: null; meta: unknown; createdAt: Date });
  const create = mock(async ({ data }: { data: Record<string, unknown> }) => ({ ...data, createdAt: new Date() }));
  const db = { cutMediaObject: { findFirst: sourceRead }, cutLibraryAsset: { findFirst: prior } } as unknown as typeof prisma;
  const tx = {
    cutRenderJob: { findFirst: mock(async () => ({ state: "running" })) },
    cutFolder: { findFirst: mock(async () => ({ id: "folder" })) },
    cutLibraryAsset: { create },
  };
  const register = mock(async (_tx: Prisma.TransactionClient, object: { fileName: string }) => object.fileName);
  const io = {
    db,
    download: mock(async (_key: string, file: string) => { await writeFile(file, "original"); }),
    upload: mock(async (_key: string, _file: string, _mime: string) => { void _file; void _mime; return 5; }),
    remove: mock(async (_keys: string[]) => { void _keys; }),
    convert: mock(async () => ({ transcodedVideo: true, transcodedAudio: false, width: 64, height: 64, unchanged: false })),
    codecs: mock(async () => ({ video: "hevc", audio: "aac", videoIndex: 0, audioIndex: 1, remux: false, videoNeedsEncoding: true })),
    duration: mock(async () => 2),
    transact: async <T>(run: (tx: Prisma.TransactionClient) => Promise<T>) => run(tx as unknown as Prisma.TransactionClient),
    register,
  };
  const job = { id: "library-upload-original", userId: "owner", projectId: null, kind: "convert", outName: null, spec: { target: "library", key: source.r2Key, name: "phone.mov", folderId: "folder" } };
  const handle = { tmpDir: "", outPath: "", progress: 0, log: [] as string[] };
  const run = (canceled = () => false) => runLibraryUploadJob(job, handle, canceled, io);
  return { run, job, source, sourceRead, prior, create, register, io, tx };
}

describe("library upload worker", () => {
  test("publishes prepared media and its retained original together in the chosen folder", async () => {
    const h = harness();
    const result = await h.run();
    expect(result).toMatchObject({ id: h.job.id, fileName: "original.mp4", originalFile: "phone.mov", type: "video", duration: 2, folderId: "folder" });
    expect(h.register.mock.calls.map((call) => call[1].fileName)).toEqual(["phone.mov", "original.mp4"]);
    expect(h.create.mock.calls[0]?.[0].data).toMatchObject({ mediaObjectId: "original.mp4", folderId: "folder" });
    expect(h.io.remove).not.toHaveBeenCalled();
  });

  test("a worker replay returns its published asset without converting or charging again", async () => {
    const h = harness();
    h.prior.mockResolvedValue({ id: h.job.id, userId: "owner", mediaObjectId: "original", deletedAt: null, folderId: null, meta: { type: "video", duration: 2 }, createdAt: new Date() });
    const result: LibraryAsset = await h.run();
    expect(result.id).toBe(h.job.id);
    expect(h.io.download).not.toHaveBeenCalled();
    expect(h.register).not.toHaveBeenCalled();
  });

  test("unchanged media registers just its source", async () => {
    const h = harness();
    h.io.convert.mockResolvedValue({ unchanged: true, transcodedVideo: false, transcodedAudio: false, width: 64, height: 64 });
    expect(await h.run()).toMatchObject({ fileName: "phone.mov" });
    expect(h.register.mock.calls.length).toBe(1);
    expect(h.io.upload).not.toHaveBeenCalled();
  });

  test("conversion failure retains the original upload and publishes nothing", async () => {
    const h = harness();
    h.io.convert.mockImplementation(async () => { throw new Error("Codec unavailable"); });
    await expect(h.run()).rejects.toThrow("Codec unavailable");
    expect(h.create).not.toHaveBeenCalled();
    expect(h.register).not.toHaveBeenCalled();
    expect(h.io.remove).not.toHaveBeenCalled();
  });

  test("quota refusal removes only the staged playback object", async () => {
    const h = harness();
    h.register.mockImplementation(async () => { throw new Error("storage_quota_exceeded"); });
    await expect(h.run()).rejects.toThrow("storage_quota_exceeded");
    expect(h.create).not.toHaveBeenCalled();
    expect(h.io.remove.mock.calls).toEqual([[["cut/owner/library/original.mp4"]]]);
  });

  test("cancellation after output upload prevents publication and removes that output", async () => {
    const h = harness();
    let canceled = false;
    h.io.upload.mockImplementation(async () => { canceled = true; return 5; });
    await expect(h.run(() => canceled)).rejects.toThrow("Import canceled");
    expect(h.create).not.toHaveBeenCalled();
    expect(h.io.remove.mock.calls.length).toBe(1);
  });
});
