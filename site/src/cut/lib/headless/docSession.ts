import type { HeadlessSession } from "./bind";
import { syncFontAssets } from "../fontAssets";
import { serializeDoc, useEditor } from "../store";
import type { MediaAsset, ProjectDoc } from "../types";

// A headless run's hold on one cloud project: read the document, hydrate the
// editor store with it, and push the store's persistable slice back through
// the same versioned PUT the page's autosave uses. The version is required at
// both ends — the open fails without one, and the push always sends ?v= — so
// a concurrent writer is answered with a 409 the caller must handle.

export interface HeadlessDocSession {
  projectId: string;
  /** The doc version the store's contents are built on. */
  version: string;
}

const projectPath = (s: HeadlessSession, projectId: string) =>
  `${s.base}/api/cut-cloud/projects/${encodeURIComponent(projectId)}`;

/** Fetch a cloud project's document and open it in the editor store. */
export async function openCloudProject(
  s: HeadlessSession,
  projectId: string
): Promise<HeadlessDocSession> {
  const res = await fetch(projectPath(s, projectId), { headers: s.headers });
  if (!res.ok) throw new Error(`Could not read project ${projectId} (${res.status}).`);
  const version = res.headers.get("x-cut-doc-version");
  if (!version)
    throw new Error("The project read carried no doc version; refusing an unversioned session.");
  const doc = (await res.json()) as ProjectDoc;
  // Media rides signed R2 URLs: tool paths that read asset bytes (attachment
  // refs, sticker decodes) fetch them bare, and the /media route would answer
  // those unauthenticated fetches 401. The route URL stays the fallback for
  // anything the mint misses.
  const fileNames = (doc.assets ?? []).map((a) => a.fileName);
  const signed = new Map<string, string>();
  if (fileNames.length > 0) {
    const mint = await fetch(`${s.base}/api/cut-cloud/media/presign-get`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...s.headers },
      body: JSON.stringify({ items: fileNames.map((fileName) => ({ projectId, fileName })) }),
    }).catch(() => null);
    if (mint?.ok) {
      const body = (await mint.json()) as { urls?: { fileName: string; url: string }[] };
      for (const u of body.urls ?? []) signed.set(u.fileName, u.url);
    }
  }
  const assets: MediaAsset[] = (doc.assets ?? []).map((a) => ({
    ...a,
    url: signed.get(a.fileName) ?? `${projectPath(s, projectId)}/media/${encodeURIComponent(a.fileName)}`,
  }));
  await useEditor.getState().openProjectDoc(projectId, doc, assets);
  // The page does this from the editor; a run has to do it before it draws,
  // or a title set in the project's own font comes out in the fallback face.
  await syncFontAssets(assets);
  return { projectId, version };
}

/** Push the store's persistable slice back up on the session's version. A 409
 * means another writer moved the document past this session's base; the
 * caller decides whether to reopen and redo or surface the conflict. */
export async function pushCloudProject(
  s: HeadlessSession,
  session: HeadlessDocSession
): Promise<HeadlessDocSession> {
  const state = useEditor.getState();
  if (state.projectId !== session.projectId)
    throw new Error("The store holds a different project than this session opened.");
  const res = await fetch(
    `${projectPath(s, session.projectId)}?v=${encodeURIComponent(session.version)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...s.headers },
      body: JSON.stringify(serializeDoc(state)),
    }
  );
  if (res.status === 409)
    throw new Error("The project changed under this session — another writer holds a newer version.");
  if (!res.ok) throw new Error(`Could not save project ${session.projectId} (${res.status}).`);
  const body = (await res.json()) as { version?: number };
  if (body.version !== undefined) session.version = String(body.version);
  return session;
}
