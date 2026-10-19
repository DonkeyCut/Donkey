import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getGlobalSetting } from "@/lib/config/effective";
import { CUT_COLOR } from "../lib/colorSettings";
import type { RenderHandle } from "../server/exportPipeline";
import { makeCompatProxy, makeProxy, proxyNameFor } from "../server/proxy";
import { compatCoverIn, compatProxyNameFor, lightProxyNameFor, PROXY_SOURCE_FAULT } from "../lib/proxyNames";
import { probeDuration } from "../server/frames";
import { dedupeName } from "../server/cloud/util";
import { prisma, registerObject, unregisterObjects, type ClaimedJob } from "./db";
import { deleteObjects, downloadToFile, mediaKey, uploadFile } from "./r2";
import { runLibraryProxyJob } from "./libraryProxyJob";
import { InputFault, refusedInput } from "./settle";
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
  makeCompat: typeof makeCompatProxy;
  duration: typeof probeDuration;
  settings: () => Promise<{ proxyMaxHeight: number; proxyCrf: number; lightKbps: number }>;
}

const defaultIO: ProxyJobIO = {
  db: prisma,
  download: downloadToFile,
  upload: uploadFile,
  remove: deleteObjects,
  register: registerObject,
  unregister: unregisterObjects,
  make: makeProxy,
  makeCompat: makeCompatProxy,
  duration: probeDuration,
  settings: async () => {
    const proxy = await getGlobalSetting("cutProxy");
    return { ...CUT_COLOR, lightKbps: proxy.lightKbps };
  },
};

/**
 * Run one proxy job: pull the master (ProRes, or a heavy video) out of R2, build its preview
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
  const { file, maxHeight, compat: asked } = (job.spec ?? {}) as { file?: string; maxHeight?: number; compat?: unknown };
  const compat = compatCoverIn(asked);
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
    // A job that names a height is a heavy video's: its proxy is the light
    // copy, capped in bitrate and named apart from a full-quality one.
    const light = !!(maxHeight && maxHeight > 0);
    let name = light ? lightProxyNameFor(file) : proxyNameFor(file);
    if (compat) {
      name = compatProxyNameFor(file, compat, light);
    }
    const fileName = dedupeName(name, new Set(rows.map((r) => r.fileName)));
    const out = path.join(tmp, fileName);
    handle.outPath = out;

    const [total, settings] = await Promise.all([io.duration(src), io.settings()]);
    const opts = {
      // A heavy video's proxy asks for a smaller copy; none is larger than
      // the account allows.
      maxHeight: maxHeight && maxHeight > 0 ? Math.min(settings.proxyMaxHeight, maxHeight) : settings.proxyMaxHeight,
      crf: settings.proxyCrf,
      ...(light ? { maxKbps: settings.lightKbps } : {}),
      onProgress: (seconds: number) => {
        if (total > 0) handle.progress = Math.min(0.99, seconds / total);
      },
    };
    const made = compat ? io.makeCompat(handle, src, out, { ...opts, cover: compat }) : io.make(handle, src, out, opts);
    const outcome = await made.catch((e: unknown) => {
      // ffmpeg ran to its own end and refused the master: the row says the
      // file is at fault, so the route waits before trying it again.
      throw !isCanceled() && refusedInput(handle.proc) ? new InputFault(PROXY_SOURCE_FAULT, e) : e;
    });
    if (isCanceled()) throw new Error("Proxy canceled.");

    const key = mediaKey(job.userId, projectId, fileName);
    try {
      const mime = compat === "video" ? "video/webm" : "video/mp4";
      const bytes = await io.upload(key, out, mime);
      await io.register({
        userId: job.userId,
        projectId,
        r2Key: key,
        fileName,
        mime,
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
