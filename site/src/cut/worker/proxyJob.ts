import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getGlobalSetting } from "@/lib/config/effective";
import type { RenderHandle } from "../server/exportPipeline";
import { makeProxy, proxyNameFor } from "../server/proxy";
import { probeDuration } from "../server/frames";
import { dedupeName } from "../server/cloud/util";
import { prisma, registerObject, unregisterObjects, type ClaimedJob } from "./db";
import { deleteObjects, downloadToFile, mediaKey, uploadFile } from "./r2";
import { runLibraryProxyJob } from "./libraryProxyJob";
import type { LibraryAsset } from "../server/library";

/** What a proxy job records in CutRenderJob.result — the same shape the
 * engine's synchronous proxy route returns. */
export interface ProxyResult {
  fileName: string;
  sizeBytes: number;
  width?: number;
  height?: number;
}

/** The edges a proxy job crosses, stubbed by its test. */
export interface ProxyJobIO {
  db: typeof prisma;
  download: typeof downloadToFile;
  upload: typeof uploadFile;
  remove: typeof deleteObjects;
  register: typeof registerObject;
  unregister: typeof unregisterObjects;
  make: typeof makeProxy;
  duration: typeof probeDuration;
  settings: () => Promise<{ proxyMaxHeight: number; proxyCrf: number }>;
}

const defaultIO: ProxyJobIO = {
  db: prisma,
  download: downloadToFile,
  upload: uploadFile,
  remove: deleteObjects,
  register: registerObject,
  unregister: unregisterObjects,
  make: makeProxy,
  duration: probeDuration,
  settings: () => getGlobalSetting("cutColor"),
};

/**
 * Run one proxy job: pull the ProRes master out of R2, build its preview
 * proxy with the same code the engine runs on a Mac, and land it in the
 * project's media prefix as a quota-exempt object (kind "proxy") under a
 * name deduped against the project's files. The master is left alone; the
 * client writes the proxy onto the asset.
 */
export async function runProxyJob(
  job: ClaimedJob,
  handle: RenderHandle,
  isCanceled: () => boolean,
  io: ProxyJobIO = defaultIO
): Promise<ProxyResult | LibraryAsset> {
  // A library video's playable copy lands on the shelf, not in a project.
  if ((job.spec as { target?: string } | null)?.target === "library") {
    return runLibraryProxyJob(job, handle, isCanceled);
  }
  const { file } = (job.spec ?? {}) as { file?: string };
  if (!file) throw new Error("Proxy job has no file.");
  const projectId = job.projectId;
  if (!projectId) throw new Error("Proxy job has no project.");

  const tmp = await mkdtemp(path.join(os.tmpdir(), "cut-proxy-"));
  handle.tmpDir = tmp;
  try {
    const src = path.join(tmp, path.basename(file));
    await io.download(mediaKey(job.userId, projectId, file), src);
    if (isCanceled()) throw new Error("Proxy canceled.");

    const rows = await io.db.cutMediaObject.findMany({
      where: { projectId, kind: { in: ["media", "proxy"] } },
      select: { fileName: true },
    });
    const fileName = dedupeName(proxyNameFor(file), new Set(rows.map((r) => r.fileName)));
    const out = path.join(tmp, fileName);
    handle.outPath = out;

    const [total, settings] = await Promise.all([io.duration(src), io.settings()]);
    const outcome = await io.make(handle, src, out, {
      maxHeight: settings.proxyMaxHeight,
      crf: settings.proxyCrf,
      onProgress: (seconds) => {
        if (total > 0) handle.progress = Math.min(0.99, seconds / total);
      },
    });
    if (isCanceled()) throw new Error("Proxy canceled.");

    const key = mediaKey(job.userId, projectId, fileName);
    try {
      const bytes = await io.upload(key, out, "video/mp4");
      await io.register({
        userId: job.userId,
        projectId,
        r2Key: key,
        fileName,
        mime: "video/mp4",
        bytes,
        kind: "proxy",
      });
    } catch (err) {
      await io.unregister(job.userId, [key]).catch(() => {});
      await io.remove([key]);
      throw err;
    }
    return { fileName, ...outcome };
  } finally {
    void rm(tmp, { recursive: true, force: true });
  }
}
