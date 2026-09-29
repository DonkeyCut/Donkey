import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { libraryUploadId, libraryUploadSchema } from "@/cut/lib/libraryUpload";
import { convertToMp4, streamCodecs } from "@/cut/server/convert";
import type { RenderHandle } from "@/cut/server/exportPipeline";
import { probeDuration } from "@/cut/server/frames";
import { assetView } from "@/cut/server/cloud/library";
import type { LibraryAsset } from "@/cut/server/library";
import { prisma, registerObjectIn, storageTransaction, type ClaimedJob } from "@/cut/worker/db";
import { deleteObjects, downloadToFile, libraryKey, uploadFile } from "@/cut/worker/r2";

const dependencies = {
  db: prisma, download: downloadToFile, upload: uploadFile, remove: deleteObjects,
  convert: convertToMp4, codecs: streamCodecs, duration: probeDuration,
  transact: storageTransaction, register: registerObjectIn,
};

/** Prepare uploaded media on disk and publish one asset with its original. */
export async function runLibraryUploadJob(
  job: ClaimedJob,
  handle: RenderHandle,
  isCanceled: () => boolean,
  io = dependencies,
): Promise<LibraryAsset> {
  const input = libraryUploadSchema.parse(job.spec);
  const source = await io.db.cutMediaObject.findFirst({
    where: { userId: job.userId, r2Key: input.key, kind: "library", projectId: null },
  });
  if (!source || libraryUploadId(source.id) !== job.id) throw new Error("Upload not found.");
  const already = await io.db.cutLibraryAsset.findFirst({ where: { id: job.id, userId: job.userId } });
  if (already) {
    if (already.deletedAt) throw new Error("This imported file was deleted.");
    const media = await io.db.cutMediaObject.findFirst({ where: { id: already.mediaObjectId, userId: job.userId } });
    if (!media) throw new Error("Imported media is missing.");
    return assetView(already, media);
  }
  const checkCanceled = () => { if (isCanceled()) throw new Error("Import canceled."); };
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cut-library-upload-"));
  handle.tmpDir = tmp;
  let stagedKey: string | undefined;
  let published = false;
  try {
    checkCanceled();
    const src = path.join(tmp, path.basename(source.fileName));
    await io.download(source.r2Key, src);
    checkCanceled();
    const bytes = (await stat(src)).size;
    if (bytes !== Number(source.bytes)) throw new Error("The uploaded file is incomplete.");
    const codecs = await io.codecs(src);
    const type = codecs.video ? "video" : "audio";
    const duration = await io.duration(src);
    if (!(duration > 0)) throw new Error("This file has no readable media duration.");
    const outputName = `${source.id}.${type === "video" ? "mp4" : "m4a"}`;
    const out = path.join(tmp, outputName);
    handle.outPath = out;
    const converted = await io.convert(handle, src, out, {
      maxHeight: input.maxHeight,
      onProgress: (seconds) => { handle.progress = Math.min(0.95, seconds / duration); },
    });
    checkCanceled();
    const fileName = converted.unchanged ? source.fileName : outputName;
    const mime = type === "video" ? "video/mp4" : "audio/mp4";
    let outputBytes = 0;
    if (!converted.unchanged) {
      stagedKey = libraryKey(job.userId, fileName);
      outputBytes = await io.upload(stagedKey, out, mime);
    }
    checkCanceled();
    const row = await io.transact(async (tx) => {
      checkCanceled();
      const active = await tx.cutRenderJob.findFirst({ where: { id: job.id, userId: job.userId, state: "running" } });
      if (!active) throw new Error("Import canceled.");
      if (input.folderId && !(await tx.cutFolder.findFirst({
        where: { id: input.folderId, userId: job.userId, scope: "library" },
      }))) throw new Error("The destination folder was deleted.");
      const sourceId = await io.register(tx, {
        userId: job.userId, projectId: null, r2Key: source.r2Key, fileName: source.fileName,
        mime: source.mime, bytes, kind: "library",
      });
      const mediaObjectId = stagedKey ? await io.register(tx, {
        userId: job.userId, projectId: null, r2Key: stagedKey, fileName,
        mime, bytes: outputBytes, kind: "library",
      }) : sourceId;
      return tx.cutLibraryAsset.create({
        data: {
          id: job.id, userId: job.userId, mediaObjectId, folderId: input.folderId ?? null,
          meta: {
            name: input.name, type, duration,
            ...(converted.width ? { width: converted.width, height: converted.height } : {}),
            ...(stagedKey ? { originalFile: source.fileName } : {}),
            ...(input.source ? { source: input.source } : {}),
          },
        },
      });
    });
    published = true;
    return assetView(row, { fileName });
  } finally {
    try {
      if (stagedKey && !published) await io.remove([stagedKey]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}
