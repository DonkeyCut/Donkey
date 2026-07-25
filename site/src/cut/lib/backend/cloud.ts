// The cloud backend: hosted Cut APIs on the deployment itself, session-authed
// (same-origin cookie; no `u=` param — the server derives the account from
// the session). Routes mirror the engine's JSON shapes under /api/cut-cloud.
// Media bytes ride presigned R2 URLs minted by those routes, not this
// transport.
import type { CutBackend } from "./types";

const cloudPath = (path: string) => path.replace(/^\/api\/cut\//, "/api/cut-cloud/");

// Cloud project docs are versioned for lost-write detection: GET hands the
// current version out in a header, PUT sends it back as ?v= and gets the
// incremented one in its body. The map lives in the transport so call sites
// keep the engine's unversioned shapes.
const docVersions = new Map<string, string>();

// /projects/:id only — /projects/folders is the folder collection, not a doc.
const PROJECT_DOC = /^\/api\/cut\/projects\/(?!folders$)([^/?]+)$/;

async function cloudFetch(path: string, init?: RequestInit): Promise<Response> {
  const doc = PROJECT_DOC.exec(path);
  const method = (init?.method ?? "GET").toUpperCase();
  if (!doc || (method !== "GET" && method !== "PUT")) return fetch(cloudPath(path), init);
  const projectId = decodeURIComponent(doc[1]);

  if (method === "GET") {
    const res = await fetch(cloudPath(path), init);
    const version = res.headers.get("x-cut-doc-version");
    if (res.ok && version) docVersions.set(projectId, version);
    return res;
  }

  // A PUT with no known version is the first save; it succeeds unconditionally.
  const v = docVersions.get(projectId);
  const res = await fetch(cloudPath(path) + (v ? `?v=${encodeURIComponent(v)}` : ""), init);
  if (res.status === 409) {
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as { doc?: unknown; version?: number | string } | null;
    if (body?.version !== undefined) docVersions.set(projectId, String(body.version));
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
    if (body?.version !== undefined) docVersions.set(projectId, String(body.version));
  }
  return res;
}

/** Batch-mint signed R2 GET URLs for a cloud or shared project's media files.
 * Returns fileName -> url; anything the mint misses keeps the /media route,
 * whose 302 serves the same bytes. Dispatches through the active backend so
 * the shared driver's token prefix applies; lazy import because ./index
 * imports this module. */
export async function fetchSignedMediaUrls(
  projectId: string,
  fileNames: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (fileNames.length === 0) return out;
  try {
    const { apiFetch } = await import("./index");
    const res = await apiFetch("/api/cut/media/presign-get", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: fileNames.map((fileName) => ({ projectId, fileName })) }),
    });
    if (!res.ok) return out;
    const body = (await res.json()) as { urls?: { fileName: string; url: string }[] };
    for (const u of body.urls ?? []) out.set(u.fileName, u.url);
  } catch {
    // Signed URLs are an optimization; the route fallback still streams.
  }
  return out;
}

/** Friendly message for a presign 413 quota rejection, else null. */
export function quotaErrorMessage(
  status: number,
  body: { error?: string } | null | undefined
): string | null {
  return status === 413 && body?.error === "storage_quota_exceeded"
    ? "Cloud storage is full — free space in your projects or delete unused media."
    : null;
}

export const cloudBackend: CutBackend = {
  kind: "cloud",
  caps: {
    importUrl: true, // executed by the render worker
    liveMic: true, // hosted LLM STT (lib/cloudTranscribe.ts)
    transcribe: true, // hosted LLM STT (lib/cloudTranscribe.ts)
    captionAi: true, // hosted Gemini twin (server/cloud/captions.ts)
    localCliChat: false, // by design: those are the user's local logins
    revealInFinder: false,
    watch: true, // browser seek + canvas contact sheets (lib/media.ts)
  },
  fetch: (path, init) => cloudFetch(path, init),
  url: (path) => cloudPath(path),
};
