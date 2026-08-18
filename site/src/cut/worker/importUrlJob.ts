import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { download } from "../server/urlDownload";
import { prisma, registerObject, unregisterObjects, type ClaimedJob } from "./db";
import { deleteObjects, mediaKey, mimeFor, uploadFile } from "./r2";

/** What an import_url job records in CutRenderJob.result — the same shape the
 * engine's synchronous import route returns to the client. */
export interface ImportUrlResult {
  files: { fileName: string; title: string }[];
  text?: string;
}

/** First variant of `base` (stem, stem-1, stem-2, …) not already `taken` —
 * the engine's on-disk dedupe scheme, run against the project's media rows. */
export function dedupeName(base: string, taken: Set<string>): string {
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length) || "media";
  let name = base;
  for (let n = 1; taken.has(name); n++) name = `${stem}-${n}${ext}`;
  return name;
}

/**
 * Run one import_url job: fetch the URL into a temp dir with the shared
 * yt-dlp/tweet-photo logic, then land each file in the project's R2 media
 * prefix with a name deduped against its existing media objects.
 */
export async function runImportUrlJob(
  job: ClaimedJob,
  isCanceled: () => boolean
): Promise<ImportUrlResult> {
  const { url } = (job.spec ?? {}) as { url?: string };
  if (!url || !/^https?:\/\//i.test(url.trim())) throw new Error("Enter a valid http(s) URL.");
  const projectId = job.projectId;
  if (!projectId) throw new Error("Import job has no project.");

  const tmp = await mkdtemp(path.join(os.tmpdir(), "cut-dl-"));
  try {
    const dl = await download(url.trim(), tmp);
    if (isCanceled()) throw new Error("Import canceled.");

    const rows = await prisma.cutMediaObject.findMany({
      where: { projectId, kind: "media" },
      select: { fileName: true },
    });
    const taken = new Set(rows.map((r) => r.fileName));
    const files: ImportUrlResult["files"] = [];
    // A failed or canceled run keeps no bytes: whatever it staged in R2 is
    // unregistered and deleted before the error propagates, so the project's
    // storage only ever holds media the client can still adopt.
    const staged: string[] = [];
    try {
      for (const f of dl.files) {
        if (isCanceled()) throw new Error("Import canceled.");
        const fileName = dedupeName(path.basename(f.file), taken);
        taken.add(fileName);
        const key = mediaKey(job.userId, projectId, fileName);
        staged.push(key);
        const bytes = await uploadFile(key, f.file, mimeFor(fileName));
        await registerObject({
          userId: job.userId,
          projectId,
          r2Key: key,
          fileName,
          mime: mimeFor(fileName),
          bytes,
          kind: "media",
        });
        files.push({ fileName, title: f.title });
      }
      return { files, ...(dl.text ? { text: dl.text } : {}) };
    } catch (err) {
      await unregisterObjects(job.userId, staged).catch(() => {});
      await deleteObjects(staged);
      throw err;
    }
  } finally {
    void rm(tmp, { recursive: true, force: true });
  }
}
