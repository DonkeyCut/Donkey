import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Prisma } from "@/generated/prisma/client";
import { getGlobalSetting } from "@/lib/config/effective";
import type { RenderHandle } from "../server/exportPipeline";
import { makeProxy, proxyNameFor } from "../server/proxy";
import { probeDuration } from "../server/frames";
import { assetView } from "../server/cloud/library";
import { dedupeName } from "../server/cloud/util";
import type { LibraryAsset } from "../server/library";
import { prisma, registerObjectIn, storageTransaction, type ClaimedJob } from "./db";
import { deleteObjects, downloadToFile, libraryKey, uploadFile } from "./r2";

/** The edges a library proxy job crosses, stubbed by its test. */
export interface LibraryProxyIO {
  db: typeof prisma;
  download: typeof downloadToFile;
  upload: typeof uploadFile;
  remove: typeof deleteObjects;
  make: typeof makeProxy;
  duration: typeof probeDuration;
  settings: () => Promise<{ proxyMaxHeight: number; proxyCrf: number }>;
  transact: <T>(run: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
  register: typeof registerObjectIn;
}

const defaultIO: LibraryProxyIO = {
  db: prisma,
  download: downloadToFile,
  upload: uploadFile,
  remove: deleteObjects,
  make: makeProxy,
  duration: probeDuration,
  settings: () => getGlobalSetting("cutColor"),
  transact: storageTransaction,
  register: registerObjectIn,
};

const DELETED = "This library file was deleted.";

/**
 * Build the playable copy of a library video the browser cannot decode (a
 * ProRes master): the same proxy the project preview plays, made with the
 * code the engine runs on a Mac. It lands under the account's library prefix
 * as a quota-exempt object, and the row names it in the same transaction, so
 * every device plays it from then on. The master stays the asset's file.
 */
export async function runLibraryProxyJob(
  job: ClaimedJob,
  handle: RenderHandle,
  isCanceled: () => boolean,
  io: LibraryProxyIO = defaultIO
): Promise<LibraryAsset> {
  const { assetId } = (job.spec ?? {}) as { assetId?: string };
  if (!assetId) throw new Error("Library proxy job has no asset.");
  const row = await io.db.cutLibraryAsset.findFirst({ where: { id: assetId, userId: job.userId, deletedAt: null } });
  if (!row) throw new Error(DELETED);
  const media = await io.db.cutMediaObject.findFirst({ where: { id: row.mediaObjectId, userId: job.userId } });
  if (!media) throw new Error("Library media is missing.");

  // A replay, or a second ask after the copy landed, returns what is there.
  if ((row.meta as { proxyFile?: string } | null)?.proxyFile) return assetView(row, media);

  const tmp = await mkdtemp(path.join(os.tmpdir(), "cut-library-proxy-"));
  handle.tmpDir = tmp;
  let key: string | undefined;
  let published = false;
  try {
    const src = path.join(tmp, path.basename(media.fileName));
    await io.download(media.r2Key, src);
    if (isCanceled()) throw new Error("Proxy canceled.");

    // The copy shares the library prefix, so its name is deduped against
    // every file the shelf holds there.
    const rows = await io.db.cutMediaObject.findMany({
      where: { userId: job.userId, projectId: null, kind: { in: ["library", "proxy"] } },
      select: { fileName: true },
    });
    const fileName = dedupeName(proxyNameFor(media.fileName), new Set(rows.map((r) => r.fileName)));
    const out = path.join(tmp, fileName);
    handle.outPath = out;

    const [total, settings] = await Promise.all([io.duration(src), io.settings()]);
    await io.make(handle, src, out, {
      maxHeight: settings.proxyMaxHeight,
      crf: settings.proxyCrf,
      onProgress: (seconds) => {
        if (total > 0) handle.progress = Math.min(0.99, seconds / total);
      },
    });
    if (isCanceled()) throw new Error("Proxy canceled.");

    key = libraryKey(job.userId, fileName);
    const bytes = await io.upload(key, out, "video/mp4");
    const stored = key;
    const updated = await io.transact(async (tx) => {
      // The asset may have been deleted while the copy was built.
      const live = await tx.cutLibraryAsset.findFirst({ where: { id: assetId, userId: job.userId, deletedAt: null } });
      if (!live) throw new Error(DELETED);
      await io.register(tx, {
        userId: job.userId, projectId: null, r2Key: stored, fileName, mime: "video/mp4", bytes, kind: "proxy",
      });
      const meta = { ...((live.meta ?? {}) as Record<string, unknown>), proxyFile: fileName };
      return tx.cutLibraryAsset.update({ where: { id: assetId }, data: { meta: meta as Prisma.InputJsonValue } });
    });
    published = true;
    return assetView(updated, media);
  } finally {
    try {
      if (key && !published) await io.remove([key]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}
