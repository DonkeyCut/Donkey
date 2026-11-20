import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Prisma } from "@/generated/prisma/client";
import type { RenderHandle } from "../server/exportPipeline";
import { assetView } from "../server/cloud/library";
import { renderStill } from "./cardJob";
import { prisma, registerObjectIn, storageTransaction, type ClaimedJob } from "./db";
import { deleteObjects, downloadToFile, libraryCardKey, uploadFile } from "./r2";
import { UserError } from "../lib/userError";

/** The edges a library card job crosses, stubbed by its test. */
export interface LibraryCardIO {
  db: typeof prisma;
  download: typeof downloadToFile;
  upload: typeof uploadFile;
  remove: typeof deleteObjects;
  still: typeof renderStill;
  transact: <T>(run: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
  register: typeof registerObjectIn;
}

const defaultIO: LibraryCardIO = {
  db: prisma,
  download: downloadToFile,
  upload: uploadFile,
  remove: deleteObjects,
  still: renderStill,
  transact: storageTransaction,
  register: registerObjectIn,
};

const DELETED = "This library file was deleted.";

/**
 * Draw the still a link to a shared library video unfurls with: the video's
 * first frame as a JPEG, the same still a shared project's card carries. It
 * lands on a fixed key per asset as a quota-exempt object, so the asset's
 * delete takes it along.
 */
export async function runLibraryCardJob(
  job: ClaimedJob,
  handle: RenderHandle,
  isCanceled: () => boolean,
  io: LibraryCardIO = defaultIO
): Promise<{ key: string }> {
  const { assetId } = (job.spec ?? {}) as { assetId?: string };
  if (!assetId) throw new Error("Library card job has no asset.");
  const row = await io.db.cutLibraryAsset.findFirst({ where: { id: assetId, userId: job.userId, deletedAt: null } });
  if (!row) throw new UserError("library_file_deleted", DELETED);
  const media = await io.db.cutMediaObject.findFirst({ where: { id: row.mediaObjectId, userId: job.userId } });
  if (!media) throw new UserError("library_media_missing", "Library media is missing.");
  if (assetView(row, media).type !== "video") throw new UserError("library_card_video_only", "Only a video takes a card.");

  const tmp = await mkdtemp(path.join(os.tmpdir(), "cut-library-card-"));
  handle.tmpDir = tmp;
  const key = libraryCardKey(job.userId, assetId);
  let published = false;
  try {
    // ffmpeg reads the master, ProRes included, so the still is its true first frame.
    const src = path.join(tmp, path.basename(media.fileName));
    await io.download(media.r2Key, src);
    if (isCanceled()) throw new UserError("render_canceled", "Canceled.");
    const out = path.join(tmp, "card.jpg");
    handle.outPath = out;
    await io.still(handle, src, out);
    if (isCanceled()) throw new UserError("render_canceled", "Canceled.");

    const bytes = await io.upload(key, out, "image/jpeg");
    await io.transact(async (tx) => {
      // The asset may have been deleted while the still was drawn.
      const live = await tx.cutLibraryAsset.findFirst({ where: { id: assetId, userId: job.userId, deletedAt: null } });
      if (!live) throw new UserError("library_file_deleted", DELETED);
      await io.register(tx, {
        userId: job.userId, projectId: null, r2Key: key, fileName: `${assetId}.jpg`, mime: "image/jpeg", bytes, kind: "card",
      });
    });
    published = true;
    return { key };
  } finally {
    try {
      if (!published) await io.remove([key]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}
