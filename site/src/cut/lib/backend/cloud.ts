// The cloud backend: hosted Cut APIs on the deployment itself, session-authed
// (same-origin cookie; no `u=` param — the server derives the account from
// the session). Routes mirror the engine's JSON shapes under /api/cut-cloud.
// Media bytes ride presigned R2 URLs minted by those routes, not this
// transport.
import { emitStorageQuota } from "../storageQuota";
import type { CutBackend } from "./types";

const cloudPath = (path: string) => path.replace(/^\/api\/cut\//, "/api/cut-cloud/");

// Cloud project docs are versioned for lost-write detection: GET hands the
// current version out in a header, PUT sends it back as ?v= and gets the
// incremented one in its body. The map lives in the transport so call sites
// keep the engine's unversioned shapes.
const docVersions = new Map<string, string>();

// Versions only grow, so the map keeps the newest it has seen. A GET response
// that lands after a save carries the version from before it — writing that
// back would make the next PUT report a conflict against this same session.
function noteVersion(projectId: string, v: string | number | undefined | null) {
  if (v === undefined || v === null) return;
  const next = Number(v);
  const known = Number(docVersions.get(projectId));
  if (!Number.isFinite(next)) return;
  if (!Number.isFinite(known) || next > known) docVersions.set(projectId, String(next));
}

/** The doc version the transport last saw acknowledged for a project — what a
 * dirty snapshot records as the base its edits were made on top of. */
export function knownDocVersion(projectId: string): string | null {
  return docVersions.get(projectId) ?? null;
}

// A dirty snapshot resumed from disk was edited on top of a specific version.
// Its push must carry that base — not whatever version the open's own GET
// just reported — so a server copy that moved on answers 409 instead of being
// silently overwritten. The pin holds until a PUT settles (ok or conflict);
// transient failures keep it, so the retry still carries the base.
const basePins = new Map<string, string>();

export function pinDocBase(projectId: string, version: string | null) {
  if (version === null) basePins.delete(projectId);
  else basePins.set(projectId, version);
}

// One doc PUT on the wire per project: each waits for the one before it and
// reads the version at dispatch. Two saves in flight would carry the same ?v=
// and the later one would 409 against its own session's write.
const putChains = new Map<string, Promise<unknown>>();

// Doc GETs in flight, so a PUT racing the open never goes out unversioned —
// an unversioned PUT is first-save semantics and would apply unconditionally.
const docGets = new Map<string, Promise<void>>();

// /projects/:id only — /projects/folders is the folder collection, not a doc.
const PROJECT_DOC = /^\/api\/cut\/projects\/(?!folders$)([^/?]+)$/;

async function cloudFetch(path: string, init?: RequestInit): Promise<Response> {
  const doc = PROJECT_DOC.exec(path);
  const method = (init?.method ?? "GET").toUpperCase();
  if (!doc || (method !== "GET" && method !== "PUT")) return fetch(cloudPath(path), init);
  const projectId = decodeURIComponent(doc[1]);

  if (method === "GET") {
    const req = fetch(cloudPath(path), init);
    const tracked = req.then(
      (res) => {
        if (res.ok) noteVersion(projectId, res.headers.get("x-cut-doc-version"));
      },
      () => {}
    );
    docGets.set(projectId, tracked);
    void tracked.then(() => {
      if (docGets.get(projectId) === tracked) docGets.delete(projectId);
    });
    return req;
  }

  const prev = putChains.get(projectId) ?? Promise.resolve();
  const run = prev.then(() => putDoc(projectId, path, init));
  // The chain survives a failed link; the failure is the caller's to handle.
  putChains.set(projectId, run.catch(() => undefined));
  return run;
}

async function putDoc(projectId: string, path: string, init?: RequestInit): Promise<Response> {
  await docGets.get(projectId);
  // A pinned base outranks the map; with neither, an unversioned PUT is the
  // first save and succeeds unconditionally.
  const v = basePins.get(projectId) ?? docVersions.get(projectId);
  const res = await fetch(cloudPath(path) + (v ? `?v=${encodeURIComponent(v)}` : ""), init);
  if (res.ok || res.status === 409) basePins.delete(projectId);
  if (res.status === 409) {
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as { doc?: unknown; version?: number | string } | null;
    noteVersion(projectId, body?.version);
    window.dispatchEvent(
      new CustomEvent("cut-cloud-doc-conflict", {
        detail: { projectId, doc: body?.doc, version: body?.version },
      })
    );
  } else if (res.ok) {
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as { version?: number | string } | null;
    noteVersion(projectId, body?.version);
  }
  return res;
}

export interface SignedMediaBatch {
  /** fileName -> signed URL. */
  urls: Map<string, string>;
  /** Wall-clock ms when the batch's URLs stop working; null when the mint
   * came back empty or without an expiry. */
  expiresAt: number | null;
}

/** Batch-mint signed R2 GET URLs for a cloud or shared project's media files.
 * Anything the mint misses keeps the /media route, whose 302 serves the same
 * bytes. Network errors and 5xx retry with a short backoff — this runs right
 * after a laptop wakes, when the link may still be coming up. Dispatches
 * through the active backend so the shared driver's token prefix applies;
 * lazy import because ./index imports this module. */
export async function fetchSignedMediaUrls(
  projectId: string,
  fileNames: string[]
): Promise<SignedMediaBatch> {
  const out: SignedMediaBatch = { urls: new Map(), expiresAt: null };
  if (fileNames.length === 0) return out;
  const { apiFetch } = await import("./index");
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    try {
      const res = await apiFetch("/api/cut/media/presign-get", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: fileNames.map((fileName) => ({ projectId, fileName })) }),
      });
      if (res.status >= 500) continue;
      if (!res.ok) return out; // 4xx: the route fallback still streams
      const body = (await res.json()) as {
        urls?: { fileName: string; url: string }[];
        expiresIn?: number;
      };
      for (const u of body.urls ?? []) out.urls.set(u.fileName, u.url);
      if (out.urls.size > 0 && typeof body.expiresIn === "number") {
        out.expiresAt = Date.now() + body.expiresIn * 1000;
      }
      return out;
    } catch {
      // Network down — retry; signed URLs stay an optimization either way.
    }
  }
  return out;
}

/** Friendly message for a presign 413 quota rejection, else null. Also raises
 * the storage-quota wall so the upgrade dialog opens wherever the rejection
 * happened — this inline string stays as the terse fallback next to it. */
export function quotaErrorMessage(
  status: number,
  body: { error?: string; bytes?: number; quotaBytes?: number } | null | undefined
): string | null {
  if (status !== 413 || body?.error !== "storage_quota_exceeded") return null;
  emitStorageQuota({ bytes: body?.bytes, quotaBytes: body?.quotaBytes, source: "quota-413" });
  return "Cloud storage is full.";
}

export const cloudBackend: CutBackend = {
  kind: "cloud",
  caps: {
    importUrl: true, // executed by the render worker
    liveMic: true, // hosted LLM STT (lib/cloudTranscribe.ts)
    transcribe: true, // hosted LLM STT (lib/cloudTranscribe.ts)
    captionAi: true, // hosted Gemini twin (server/cloud/captions.ts)
    revealInFinder: false,
    watch: true, // browser seek + canvas contact sheets (lib/media.ts)
  },
  fetch: (path, init) => cloudFetch(path, init),
  url: (path) => cloudPath(path),
};
