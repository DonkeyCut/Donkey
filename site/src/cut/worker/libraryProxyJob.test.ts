import { describe, expect, mock, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import type { Prisma } from "@/generated/prisma/client";
import type { prisma } from "@/lib/prisma";
import { runLibraryProxyJob, type LibraryProxyIO } from "./libraryProxyJob";

type Row = { id: string; userId: string; mediaObjectId: string; folderId: string | null; deletedAt: Date | null; meta: unknown; createdAt: Date };

function harness(taken: string[] = []) {
  const row: Row = {
    id: "asset", userId: "owner", mediaObjectId: "master", folderId: "folder", deletedAt: null,
    meta: { name: "IMG_5388.MOV", type: "video", duration: 21.8, width: 1080, height: 1920, title: "Beach" },
    createdAt: new Date(0),
  };
  const media = { id: "master", fileName: "IMG_5388.MOV", r2Key: "cut/owner/library/IMG_5388.MOV" };
  const assetRead = mock(async (_args: unknown) => { void _args; return row as Row | null; });
  const takenRead = mock(async (_args: unknown) => { void _args; return taken.map((fileName) => ({ fileName })); });
  const update = mock(async ({ data }: { data: { meta: unknown } }) => ({ ...row, meta: data.meta }));
  const liveRead = mock(async (_args: unknown) => { void _args; return row as Row | null; });
  const tx = { cutLibraryAsset: { findFirst: liveRead, update } };
  const io = {
    db: {
      cutLibraryAsset: { findFirst: assetRead },
      cutMediaObject: { findFirst: mock(async () => media), findMany: takenRead },
    } as unknown as typeof prisma,
    download: mock(async (_key: string, file: string) => { await writeFile(file, "master"); }),
    upload: mock(async (_key: string, _file: string, _mime: string) => { void _file; void _mime; return 7; }),
    remove: mock(async (_keys: string[]) => { void _keys; }),
    make: mock(async (_handle: unknown, _src: string, out: string, opts: { maxHeight: number; crf: number; onProgress?: (s: number) => void }) => {
      opts.onProgress?.(1);
      await writeFile(out, "proxy");
      return { sizeBytes: 5, width: 608, height: 1080 };
    }),
    duration: mock(async () => 21.8),
    settings: mock(async () => ({ proxyMaxHeight: 1080, proxyCrf: 20 })),
    transact: async <T>(run: (tx: Prisma.TransactionClient) => Promise<T>) => run(tx as unknown as Prisma.TransactionClient),
    register: mock(async (_tx: Prisma.TransactionClient, object: { fileName: string }) => object.fileName),
  } satisfies LibraryProxyIO;
  const job = { id: "library-proxy-asset", userId: "owner", projectId: null, kind: "proxy", outName: null, spec: { target: "library", assetId: "asset" } };
  const handle = { tmpDir: "", outPath: "", progress: 0, log: [] as string[] };
  const run = (canceled = () => false) => runLibraryProxyJob(job, handle, canceled, io);
  return { run, io, row, update, liveRead, takenRead, handle };
}

describe("library proxy worker", () => {
  // A ProRes master stays the asset's file; the playable copy lands beside it
  // as an exempt object and the row names it, keeping everything else it says.
  test("builds the copy from the master and records it on the row", async () => {
    const h = harness();
    const asset = await h.run();
    expect(asset).toMatchObject({ id: "asset", fileName: "IMG_5388.MOV", proxyFile: "IMG_5388.proxy.mp4", title: "Beach" });
    expect(h.io.download.mock.calls[0][0]).toBe("cut/owner/library/IMG_5388.MOV");
    expect(h.io.make.mock.calls[0][3]).toMatchObject({ maxHeight: 1080, crf: 20 });
    expect(h.io.upload.mock.calls[0][0]).toBe("cut/owner/library/IMG_5388.proxy.mp4");
    expect(h.io.register.mock.calls[0][1]).toMatchObject({
      userId: "owner", projectId: null, fileName: "IMG_5388.proxy.mp4", kind: "proxy", mime: "video/mp4", bytes: 7,
    });
    expect(h.update.mock.calls[0][0].data.meta).toMatchObject({ title: "Beach", proxyFile: "IMG_5388.proxy.mp4" });
    expect(h.handle.progress).toBeGreaterThan(0);
  });

  test("dedupes the copy's name against the account's library files", async () => {
    const h = harness(["IMG_5388.proxy.mp4"]);
    expect((await h.run()).proxyFile).toBe("IMG_5388.proxy-1.mp4");
    expect(h.takenRead.mock.calls[0][0]).toMatchObject({ where: { userId: "owner", projectId: null, kind: { in: ["library", "proxy"] } } });
  });

  test("a row that already names its copy returns without building", async () => {
    const h = harness();
    h.row.meta = { ...(h.row.meta as object), proxyFile: "IMG_5388.proxy.mp4" };
    expect((await h.run()).proxyFile).toBe("IMG_5388.proxy.mp4");
    expect(h.io.download).not.toHaveBeenCalled();
  });

  test("an asset deleted while the copy was built takes the copy with it", async () => {
    const h = harness();
    h.liveRead.mockResolvedValue(null);
    await expect(h.run()).rejects.toThrow("deleted");
    expect(h.io.remove.mock.calls[0][0]).toEqual(["cut/owner/library/IMG_5388.proxy.mp4"]);
    expect(h.update).not.toHaveBeenCalled();
  });
});
