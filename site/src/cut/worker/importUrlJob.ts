import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Prisma } from "@/generated/prisma/client";
import { dedupeName, inspirationFolderId, safeFileName, typeOf } from "../server/cloud/util";
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
  const { url, target, origin, audio, maxBytes } = (job.spec ?? {}) as {
    url?: string;
    target?: string;
    origin?: string;
    audio?: boolean;
    /** What is left of the account's storage when the job was queued; the
     * route always sets it. Everything that came down is measured against it
     * before any byte is uploaded — the one place every rung and every
     * conversion passes through. */
    maxBytes?: number;
  };
  if (typeof maxBytes !== "number" || !(maxBytes > 0))
    throw new Error("There is no storage left on this account for an import.");
  if (!url || !/^https?:\/\//i.test(url.trim())) throw new Error("Enter a valid http(s) URL.");
  const toLibrary = target === "library";
  const projectId = job.projectId;
  if (!toLibrary && !projectId) throw new Error("Import job has no project.");
  // An inspiration link's downloads are filed into the ensured Inspiration
  // folder and tagged with the origin the desktop filters read.
  const inspiration = toLibrary && origin === "inspiration";
  let folderId: string | null = null;
  if (inspiration) {
    folderId = inspirationFolderId(job.userId);
    await prisma.cutFolder.upsert({
      where: { id: folderId },
      create: { id: folderId, userId: job.userId, name: "Inspiration", scope: "library" },
      update: {},
    });
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), "cut-dl-"));
  try {
    const dl = await download(url.trim(), tmp, { audio: audio === true });
    if (isCanceled()) throw new Error("Import canceled.");
    let landing = 0;
    for (const f of dl.files) {
      landing += (await stat(f.file)).size;
      if (f.poster) landing += (await stat(f.poster)).size;
    }
    if (landing > maxBytes)
      throw new Error("The download is larger than the storage left on this account.");

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
        // The source's cover rides in as its own object under the same
        // library prefix: the media route serves it by name like any other
        // file, and the asset's delete takes it down with the media.
        let posterFile: string | undefined;
        if (f.poster) {
          posterFile = dedupeName(`${fileName}.poster${path.extname(f.poster)}`, taken);
          taken.add(posterFile);
          const posterKey = libraryKey(job.userId, posterFile);
          staged.push(posterKey);
          const posterBytes = await uploadFile(posterKey, f.poster, mimeFor(posterFile));
          await registerObject({
            userId: job.userId,
            projectId: null,
            r2Key: posterKey,
            fileName: posterFile,
            mime: mimeFor(posterFile),
            bytes: posterBytes,
            kind: "library",
          });
        }
        const asset = await addLibraryRow(
          job.userId,
          objectId,
          fileName,
          f.file,
          f.title,
          dl.source,
          posterFile,
          inspiration ? { folderId: folderId!, origin: "inspiration" } : undefined
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
  source: LibraryAsset["source"],
  posterFile?: string,
  filing?: { folderId: string; origin: "inspiration" }
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
    ...(posterFile ? { posterFile } : {}),
    ...(filing ? { origin: filing.origin } : {}),
  };
  const row = await prisma.cutLibraryAsset.create({
    data: {
      userId,
      mediaObjectId,
      folderId: filing?.folderId ?? null,
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
    folderId: filing?.folderId ?? null,
    ...(source ? { source } : {}),
    ...(posterFile ? { posterFile } : {}),
    ...(filing ? { origin: filing.origin } : {}),
  };
}
