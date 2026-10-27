import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Prisma } from "@/generated/prisma/client";
import { CUT_COLOR } from "@/cut/lib/colorSettings";
import type { RenderHandle } from "../server/exportPipeline";
import { makeCompatProxy, makeProxy, proxyNameFor } from "../server/proxy";
import { compatCoverIn, compatCovers, compatProxyNameFor } from "../lib/proxyNames";
import { probeDuration } from "../server/frames";
import { assetView } from "../server/cloud/library";
import { dedupeName } from "../server/cloud/util";
import type { LibraryAsset } from "../server/library";
import { prisma, registerObjectIn, storageTransaction, type ClaimedJob } from "./db";
import { deleteObjects, downloadToFile, libraryKey, uploadFile } from "./r2";
import { UserError } from "../lib/userError";

/** The edges a library proxy job crosses, stubbed by its test. */
export interface LibraryProxyIO {
  db: typeof prisma;
  download: typeof downloadToFile;
  upload: typeof uploadFile;
  remove: typeof deleteObjects;
  make: typeof makeProxy;
  makeCompat: typeof makeCompatProxy;
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
  makeCompat: makeCompatProxy,
  duration: probeDuration,
  settings: async () => CUT_COLOR,
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
  const { assetId, compat: asked } = (job.spec ?? {}) as { assetId?: string; compat?: unknown };
  const compat = compatCoverIn(asked);
  if (!assetId) throw new Error("Library proxy job has no asset.");
  const row = await io.db.cutLibraryAsset.findFirst({ where: { id: assetId, userId: job.userId, deletedAt: null } });
  if (!row) throw new UserError("library_file_deleted", DELETED);
  const media = await io.db.cutMediaObject.findFirst({ where: { id: row.mediaObjectId, userId: job.userId } });
  if (!media) throw new UserError("library_media_missing", "Library media is missing.");

  // A replay, or a second ask after the copy landed, returns what is there.
  const had = (row.meta as { proxyFile?: string } | null)?.proxyFile;
  if (had && (!compat || compatCovers(had, compat))) return assetView(row, media);

  const tmp = await mkdtemp(path.join(os.tmpdir(), "cut-library-proxy-"));
  handle.tmpDir = tmp;
  let key: string | undefined;
  let published = false;
  try {
    const src = path.join(tmp, path.basename(media.fileName));
    await io.download(media.r2Key, src);
    if (isCanceled()) throw new UserError("proxy_canceled", "Proxy canceled.");

    // The copy shares the library prefix, so its name is deduped against
    // every file the shelf holds there.
    const rows = await io.db.cutMediaObject.findMany({
      where: { userId: job.userId, projectId: null, kind: { in: ["library", "proxy"] } },
      select: { fileName: true },
    });
    const name = compat ? compatProxyNameFor(media.fileName, compat, false) : proxyNameFor(media.fileName);
    const fileName = dedupeName(name, new Set(rows.map((r) => r.fileName)));
    const out = path.join(tmp, fileName);
    handle.outPath = out;

    const [total, settings] = await Promise.all([io.duration(src), io.settings()]);
    const opts = {
      maxHeight: settings.proxyMaxHeight,
      crf: settings.proxyCrf,
      onProgress: (seconds: number) => {
        if (total > 0) handle.progress = Math.min(0.99, seconds / total);
      },
    };
    await (compat ? io.makeCompat(handle, src, out, { ...opts, cover: compat }) : io.make(handle, src, out, opts));
    if (isCanceled()) throw new UserError("proxy_canceled", "Proxy canceled.");

    key = libraryKey(job.userId, fileName);
    const mime = compat === "video" ? "video/webm" : "video/mp4";
    const bytes = await io.upload(key, out, mime);
    let replaced: string | undefined;
    const stored = key;
    const updated = await io.transact(async (tx) => {
      // The asset may have been deleted while the copy was built.
      const live = await tx.cutLibraryAsset.findFirst({ where: { id: assetId, userId: job.userId, deletedAt: null } });
      if (!live) throw new UserError("library_file_deleted", DELETED);
      await io.register(tx, {
        userId: job.userId, projectId: null, r2Key: stored, fileName, mime, bytes, kind: "proxy",
      });
      // A compat copy takes the place of a copy this browser cannot play;
      // the old one's object leaves with its name.
      const before = (live.meta as { proxyFile?: string } | null)?.proxyFile;
      if (before) {
        const old = await tx.cutMediaObject.findFirst({ where: { userId: job.userId, projectId: null, kind: "proxy", fileName: before } });
        if (old) {
          await tx.cutMediaObject.delete({ where: { id: old.id } });
          replaced = old.r2Key;
        }
      }
      const meta = { ...((live.meta ?? {}) as Record<string, unknown>), proxyFile: fileName };
      return tx.cutLibraryAsset.update({ where: { id: assetId }, data: { meta: meta as Prisma.InputJsonValue } });
    });
    published = true;
    if (replaced) {
      await io.remove([replaced]).catch(() => {});
    }
    return assetView(updated, media);
  } finally {
    try {
      if (key && !published) await io.remove([key]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}
