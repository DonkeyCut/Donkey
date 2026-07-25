// The shared backend: a read-only view of someone else's cloud project,
// reached through the public /api/cut-shared/<token>/* surface. The token is
// the share link's id; the viewer page binds it before the editor mounts.
// Reads only — the viewer never PUTs, so there is no write-conflict version
// map here; the version it does keep is the one the last doc actually
// delivered, which is what tells the change poll whether a reload landed.
import type { CutBackend } from "./types";

let token = "";

/** Bind the share link token before setCutMode("shared"). */
export function bindSharedBackend(next: string) {
  token = next;
}

const sharedPath = (path: string) =>
  path.replace(/^\/api\/cut\//, `/api/cut-shared/${encodeURIComponent(token)}/`);

// /projects/:id only — /projects/folders is the folder collection, not a doc.
const PROJECT_DOC = /^\/api\/cut\/projects\/(?!folders$)([^/?]+)$/;

const loadedVersions = new Map<string, string>();

/** The doc version the viewer is actually showing for a project, as reported
 * by the response that delivered it. The change poll compares against this
 * rather than against the last version it saw announced: a cached doc can
 * trail the version header the poll reads, and trusting the poll would leave
 * the viewer holding an older cut while believing it was current. */
export function loadedDocVersion(projectId: string): string | null {
  return loadedVersions.get(projectId) ?? null;
}

async function sharedFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(sharedPath(path), init);
  const doc = PROJECT_DOC.exec(path);
  const method = (init?.method ?? "GET").toUpperCase();
  if (doc && method === "GET" && res.ok) {
    const version = res.headers.get("x-cut-doc-version");
    if (version) loadedVersions.set(decodeURIComponent(doc[1]), version);
  }
  return res;
}

export const sharedBackend: CutBackend = {
  kind: "shared",
  caps: {
    importUrl: false,
    liveMic: false,
    transcribe: false,
    captionAi: false,
    localCliChat: false,
    revealInFinder: false,
    watch: false,
  },
  fetch: sharedFetch,
  url: (path) => sharedPath(path),
};
