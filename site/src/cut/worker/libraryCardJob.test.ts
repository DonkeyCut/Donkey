import { describe, expect, mock, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import type { Prisma } from "@/generated/prisma/client";
import type { prisma } from "@/lib/prisma";
import { runLibraryCardJob, type LibraryCardIO } from "./libraryCardJob";

type Row = { id: string; userId: string; mediaObjectId: string; folderId: string | null; deletedAt: Date | null; meta: unknown; createdAt: Date };

function harness(type = "video") {
  const row: Row = {
    id: "asset", userId: "owner", mediaObjectId: "master", folderId: null, deletedAt: null,
    meta: { name: "IMG_5388.MOV", type, duration: 21.8 }, createdAt: new Date(0),
  };
  const media = { id: "master", fileName: "IMG_5388.MOV", r2Key: "cut/owner/library/IMG_5388.MOV" };
  const liveRead = mock(async (_args: unknown) => { void _args; return row as Row | null; });
  const tx = { cutLibraryAsset: { findFirst: liveRead } };
  const io = {
    db: {
      cutLibraryAsset: { findFirst: mock(async () => row) },
      cutMediaObject: { findFirst: mock(async () => media) },
    } as unknown as typeof prisma,
    download: mock(async (_key: string, file: string) => { await writeFile(file, "master"); }),
    upload: mock(async (_key: string, _file: string, _mime: string) => { void _file; void _mime; return 9; }),
    remove: mock(async (_keys: string[]) => { void _keys; }),
    still: mock(async (_handle: unknown, _src: string, dest: string) => { await writeFile(dest, "jpeg"); return 4; }),
    transact: async <T>(run: (tx: Prisma.TransactionClient) => Promise<T>) => run(tx as unknown as Prisma.TransactionClient),
    register: mock(async (_tx: Prisma.TransactionClient, object: { fileName: string }) => object.fileName),
  } satisfies LibraryCardIO;
  const job = { id: "library-card-asset", userId: "owner", projectId: null, kind: "library_card", outName: null, spec: { assetId: "asset" } };
  const handle = { tmpDir: "", outPath: "", progress: 0, log: [] as string[] };
  const run = (canceled = () => false) => runLibraryCardJob(job, handle, canceled, io);
  return { run, io, liveRead };
}

describe("library card worker", () => {
  // The still is the master's first frame, stored on the asset's fixed key
  // as an exempt card object.
  test("draws the first frame of the master and registers it", async () => {
    const h = harness();
    expect(await h.run()).toEqual({ key: "cut/owner/library-cards/asset.jpg" });
    expect(h.io.download.mock.calls[0][0]).toBe("cut/owner/library/IMG_5388.MOV");
    expect(h.io.upload.mock.calls[0][0]).toBe("cut/owner/library-cards/asset.jpg");
    expect(h.io.register.mock.calls[0][1]).toMatchObject({ projectId: null, kind: "card", mime: "image/jpeg", bytes: 9 });
    expect(h.io.remove).not.toHaveBeenCalled();
  });

  test("only a video takes a card", async () => {
    const h = harness("audio");
    await expect(h.run()).rejects.toThrow("Only a video takes a card.");
    expect(h.io.download).not.toHaveBeenCalled();
  });

  // An asset deleted while the still was drawn leaves no object behind.
  test("a delete mid-run removes the uploaded still", async () => {
    const h = harness();
    h.liveRead.mockResolvedValue(null);
    await expect(h.run()).rejects.toThrow("This library file was deleted.");
    expect(h.io.remove.mock.calls[0][0]).toEqual(["cut/owner/library-cards/asset.jpg"]);
    expect(h.io.register).not.toHaveBeenCalled();
  });
});
