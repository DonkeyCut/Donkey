import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addDownloaded, type LibraryAsset, type LibrarySource } from "./library";
import { assertLocalRuntime } from "./local-only";
import { mediaDir, mediaPath as projectMediaPath, readProject } from "./projects";
import { download, type Downloaded } from "./urlDownload";
import { uniqueName } from "./util";

// Import a URL (TikTok, YouTube, Instagram, an X post, a page, …) into the
// library or a project. The fetch itself lives in urlDownload.ts (the bundled yt-dlp,
// resolved from the widened PATH — tool-path.ts — exactly like ffmpeg); this
// module owns the local landing spots and the concurrency guard.

// A small ceiling so a burst of pastes can't spawn unbounded downloads.
const MAX_ACTIVE = 2;
let active = 0;

/** Run one guarded download and hand the files to `consume` before the temp
 * dir is deleted. The active slot spans the whole operation; mkdtemp runs
 * inside the try so a failure there still releases the slot (else a rejection
 * would leak it and, after MAX_ACTIVE failures, brick URL import until
 * restart). */
async function withDownload<T>(url: string, consume: (dl: Downloaded) => Promise<T>): Promise<T> {
  assertLocalRuntime();
  if (!/^https?:\/\//i.test(url.trim())) throw new Error("Enter a valid http(s) URL.");
  if (active >= MAX_ACTIVE) {
    throw new Error("Too many downloads in progress. Try again in a moment.");
  }
  active++;
  try {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "cut-dl-"));
    try {
      return await consume(await download(url.trim(), tmp));
    } finally {
      void rm(tmp, { recursive: true, force: true });
    }
  } finally {
    active--;
  }
}

/** Download a URL into the shared Library (the Library panel's import box).
 * A multi-photo post lands as one asset per photo. The Library holds media, so
 * a source that turned out to be only words fails here — the chat's import is
 * where text lands. */
export async function importFromUrl(url: string): Promise<LibraryAsset[]> {
  return withDownload(url, async (dl) => {
    if (dl.files.length === 0) throw new Error("That link has no media to import.");
    const assets: LibraryAsset[] = [];
    for (const f of dl.files) {
      assets.push(await addDownloaded(f.file, f.title, dl.source, f.poster));
    }
    return assets;
  });
}

/** Download a URL straight into a project's media folder (the chat's
 * import_url tool). Returns the project file names — none when the source is
 * only words, which come back as `text` — and the client builds and registers
 * the assets. */
export async function importUrlToProject(
  projectId: string,
  url: string
): Promise<{ files: { fileName: string; title: string }[]; source: LibrarySource; text?: string }> {
  if (!(await readProject(projectId))) throw new Error("Project not found.");
  return withDownload(url, async (dl) => {
    await mkdir(mediaDir(projectId), { recursive: true });
    const files: { fileName: string; title: string }[] = [];
    for (const f of dl.files) {
      const dest = await uniqueName(path.basename(f.file), (n) => projectMediaPath(projectId, n));
      await copyFile(f.file, projectMediaPath(projectId, dest));
      files.push({ fileName: dest, title: f.title });
    }
    return { files, source: dl.source, text: dl.text };
  });
}
