// Copy a project between backends: read the source doc, create the target
// project, move every media file's bytes across (in doc order — the fresh
// target dedupes only against names this copy already claimed), remap asset
// fileNames, save the doc, and carry the chat history. A failure deletes the
// half-made copy. Shared by the projects home's "Duplicate to cloud/Mac" and
// the editor's move.
import type { CutBackend } from "./backend/types";
import { fetchCloudThreads, putCloudThread } from "./chatCloud";
import { mergeThreads, readProjectThreads, writeProjectThreads } from "./chatThreads";
import { uploadProjectMediaTo } from "./media";
import type { ProjectDoc } from "./types";

/** Move a project's conversations onto the copy.
 *
 * Chat-created media belongs to a thread: it rides the doc like any other
 * asset, but only its thread shows it, and only deleting that thread deletes
 * it. A copy that took the media and left the conversations behind would hold
 * media nobody can see, delete, or account for — while it still counts against
 * the account's storage. So the threads travel with it. */
async function copyChatThreads(
  src: CutBackend,
  dst: CutBackend,
  srcProjectId: string,
  dstProjectId: string
): Promise<void> {
  const threads = mergeThreads(
    await fetchCloudThreads(src, srcProjectId),
    readProjectThreads(srcProjectId)
  );
  if (threads.length === 0) return;
  writeProjectThreads(dstProjectId, threads);
  for (const thread of threads) {
    await putCloudThread(dst, dstProjectId, thread);
  }
}

export async function copyProjectAcross(
  src: CutBackend,
  dst: CutBackend,
  projectId: string,
  opts: {
    /** Target name from the source doc's name; defaults to keeping it. */
    rename?: (docName: string) => string;
    /** Called per media file as its bytes land on the target. */
    onProgress?: (done: number, total: number) => void;
  } = {}
): Promise<string> {
  let created: string | null = null;
  try {
    const docRes = await src.fetch(`/api/cut/projects/${projectId}`);
    if (!docRes.ok) throw new Error("Could not read the project.");
    const doc = (await docRes.json()) as ProjectDoc;
    const name = opts.rename ? opts.rename(doc.name ?? "") : (doc.name ?? "");
    const createRes = await dst.fetch("/api/cut/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const summary = (await createRes.json()) as { id?: string };
    if (!createRes.ok || !summary.id) throw new Error("Could not create the project.");
    created = summary.id;
    const assets = Array.isArray(doc.assets) ? doc.assets : [];
    const names = new Map<string, string>();
    const unique = new Set(assets.map((a) => a.fileName)).size;
    for (const a of assets) {
      if (names.has(a.fileName)) continue;
      const bytes = await src.fetch(
        `/api/cut/projects/${projectId}/media/${encodeURIComponent(a.fileName)}`
      );
      if (!bytes.ok) throw new Error(`Could not read “${a.name}”.`);
      names.set(
        a.fileName,
        await uploadProjectMediaTo(dst, summary.id, await bytes.blob(), a.fileName)
      );
      opts.onProgress?.(names.size, unique);
    }
    const copied: ProjectDoc = {
      ...doc,
      // The copy is a new project; the target backend stamps its own id.
      id: undefined,
      name,
      folderId: null,
      assets: assets.map((a) => ({ ...a, fileName: names.get(a.fileName) ?? a.fileName })),
    };
    const putRes = await dst.fetch(`/api/cut/projects/${summary.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(copied),
    });
    if (!putRes.ok) throw new Error("Could not save the project.");
    await copyChatThreads(src, dst, projectId, summary.id);
    return summary.id;
  } catch (e) {
    if (created) {
      void dst.fetch(`/api/cut/projects/${created}`, { method: "DELETE" }).catch(() => {});
    }
    throw e;
  }
}
