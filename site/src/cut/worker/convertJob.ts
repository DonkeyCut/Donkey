import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RenderHandle } from "../server/exportPipeline";
import { convertToMp4, mp4NameFor } from "../server/convert";
import { probeDuration } from "../server/frames";
import { prisma, registerObject, unregisterObjects, type ClaimedJob } from "./db";
import { dedupeName } from "./importUrlJob";
import { deleteObjects, downloadToFile, mediaKey, uploadFile } from "./r2";

/** What a convert job records in CutRenderJob.result — the same shape the
 * engine's synchronous convert route returns. */
export interface ConvertResult {
  fileName: string;
  duration: number;
  width?: number;
  height?: number;
  transcodedVideo: boolean;
  transcodedAudio: boolean;
  /** The project's file was already what this would produce. */
  unchanged?: boolean;
}

/**
 * Run one convert job: pull the project's media file out of R2, rewrite it as
 * MP4 with the same code the engine runs on a Mac, and land the result in the
 * project's media prefix under a name deduped against its existing objects.
 * The original is left alone — the client swaps its asset over and deletes
 * what it no longer points at.
 */
export async function runConvertJob(
  job: ClaimedJob,
  handle: RenderHandle,
  isCanceled: () => boolean
): Promise<ConvertResult> {
  const { file, maxHeight } = (job.spec ?? {}) as { file?: string; maxHeight?: number };
  if (!file) throw new Error("Convert job has no file.");
  const projectId = job.projectId;
  if (!projectId) throw new Error("Convert job has no project.");

  const tmp = await mkdtemp(path.join(os.tmpdir(), "cut-convert-"));
  handle.tmpDir = tmp;
  try {
    const src = path.join(tmp, path.basename(file));
    await downloadToFile(mediaKey(job.userId, projectId, file), src);
    if (isCanceled()) throw new Error("Conversion canceled.");

    const rows = await prisma.cutMediaObject.findMany({
      where: { projectId, kind: "media" },
      select: { fileName: true },
    });
    const fileName = dedupeName(mp4NameFor(file), new Set(rows.map((r) => r.fileName)));
    const out = path.join(tmp, fileName);
    handle.outPath = out;

    const total = await probeDuration(src);
    const outcome = await convertToMp4(handle, src, out, {
      maxHeight,
      onProgress: (seconds) => {
        if (total > 0) handle.progress = Math.min(0.99, seconds / total);
      },
    });
    if (isCanceled()) throw new Error("Conversion canceled.");
    // Already the file this would produce: the object in R2 stays as it is.
    if (outcome.unchanged) return { fileName: file, duration: total, ...outcome };

    const key = mediaKey(job.userId, projectId, fileName);
    try {
      const bytes = await uploadFile(key, out, "video/mp4");
      await registerObject({
        userId: job.userId,
        projectId,
        r2Key: key,
        fileName,
        mime: "video/mp4",
        bytes,
        kind: "media",
      });
    } catch (err) {
      await unregisterObjects(job.userId, [key]).catch(() => {});
      await deleteObjects([key]);
      throw err;
    }
    return { fileName, duration: await probeDuration(out), ...outcome };
  } finally {
    void rm(tmp, { recursive: true, force: true });
  }
}
