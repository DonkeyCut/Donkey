import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Prisma } from "@/generated/prisma/client";
import { dedupeName, safeFileName, typeOf } from "../server/cloud/util";
import type { LibraryAsset } from "../server/library";
import { probeDuration } from "../server/frames";
import { download } from "../server/urlDownload";
import { videoDimensions } from "../server/util";
import { prisma, registerObject, unregisterObjects, type ClaimedJob } from "./db";
import { deleteObjects, libraryKey, mediaKey, mimeFor, uploadFile } from "./r2";

/** What a project import_url job records in CutRenderJob.result — the same
 * shape the engine's synchronous import route returns to the client. */
export interface ImportUrlResult {
  files: { fileName: string; title: string }[];
  text?: string;
}

/** What a library import_url job records: the assets, exactly as the engine's
 * library import answers with (minus the residency the client stamps on), plus
 * the source's own words — a browser project imports through this job, and its
 * chat quotes that text the way a project import does. */
export interface LibraryImportResult {
  assets: LibraryAsset[];
  text?: string;
}

/**
 * Run one import_url job: fetch the URL into a temp dir with the shared
 * yt-dlp/tweet-photo logic, then land what came back — in the project's R2
 * media prefix, or in the account's library when the job carries no project.
 */
export async function runImportUrlJob(
  job: ClaimedJob,
  isCanceled: () => boolean
): Promise<ImportUrlResult | LibraryImportResult> {
  const { url, target } = (job.spec ?? {}) as { url?: string; target?: string };
  if (!url || !/^https?:\/\//i.test(url.trim())) throw new Error("Enter a valid http(s) URL.");
  const toLibrary = target === "library";
  const projectId = job.projectId;
  if (!toLibrary && !projectId) throw new Error("Import job has no project.");

  const tmp = await mkdtemp(path.join(os.tmpdir(), "cut-dl-"));
  try {
    const dl = await download(url.trim(), tmp);
    if (isCanceled()) throw new Error("Import canceled.");

    const rows = await prisma.cutMediaObject.findMany({
      where: toLibrary ? { userId: job.userId, kind: "library" } : { projectId, kind: "media" },
      select: { fileName: true },
    });
    const taken = new Set(rows.map((r) => r.fileName));
    const files: ImportUrlResult["files"] = [];
    const assets: LibraryAsset[] = [];
    // A failed or canceled run keeps no bytes: whatever it staged in R2 is
    // unregistered and deleted before the error propagates, so the account's
    // storage only ever holds media the client can still adopt. Library rows
    // written for the files that already landed go with them — a card whose
    // media was just deleted is a card nothing can open.
    const staged: string[] = [];
    const libraryRows: string[] = [];
    try {
      for (const f of dl.files) {
        if (isCanceled()) throw new Error("Import canceled.");
        const base = toLibrary ? safeFileName(f.file) : path.basename(f.file);
        const fileName = dedupeName(base, taken);
        taken.add(fileName);
        const key = toLibrary
          ? libraryKey(job.userId, fileName)
          : mediaKey(job.userId, projectId!, fileName);
        staged.push(key);
        const bytes = await uploadFile(key, f.file, mimeFor(fileName));
        const objectId = await registerObject({
          userId: job.userId,
          projectId: toLibrary ? null : projectId,
          r2Key: key,
          fileName,
          mime: mimeFor(fileName),
          bytes,
          kind: toLibrary ? "library" : "media",
        });
        if (!toLibrary) {
          files.push({ fileName, title: f.title });
          continue;
        }
        const asset = await addLibraryRow(
          job.userId,
          objectId,
          fileName,
          f.file,
          f.title,
          dl.source
        );
        libraryRows.push(asset.id);
        assets.push(asset);
      }
      if (toLibrary) return { assets, ...(dl.text ? { text: dl.text } : {}) };
      return { files, ...(dl.text ? { text: dl.text } : {}) };
    } catch (err) {
      if (libraryRows.length > 0)
        await prisma.cutLibraryAsset
          .deleteMany({ where: { userId: job.userId, id: { in: libraryRows } } })
          .catch(() => {});
      await unregisterObjects(job.userId, staged).catch(() => {});
      await deleteObjects(staged);
      throw err;
    }
  } finally {
    void rm(tmp, { recursive: true, force: true });
  }
}

/** Register one downloaded file as a library asset, probing the local copy for
 * the shape the library card reads (duration, pixel size). */
async function addLibraryRow(
  userId: string,
  mediaObjectId: string,
  fileName: string,
  localFile: string,
  title: string,
  source: LibraryAsset["source"]
): Promise<LibraryAsset> {
  const type = typeOf(fileName);
  if (!type) throw new Error("Unsupported file type.");
  const duration = type === "image" ? 0 : await probeDuration(localFile);
  const dims = type === "audio" ? null : await videoDimensions(localFile);
  const meta = {
    name: title || fileName,
    type,
    duration,
    ...(dims ? { width: dims.width, height: dims.height } : {}),
    ...(source ? { source } : {}),
  };
  const row = await prisma.cutLibraryAsset.create({
    data: {
      userId,
      mediaObjectId,
      meta: meta as unknown as Prisma.InputJsonValue,
    },
  });
  return {
    id: row.id,
    fileName,
    name: meta.name,
    type,
    duration,
    ...(dims ? { width: dims.width, height: dims.height } : {}),
    addedAt: row.createdAt.getTime(),
    folderId: null,
    ...(source ? { source } : {}),
  };
}
