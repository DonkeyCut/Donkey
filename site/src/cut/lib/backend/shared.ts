// The shared backend: a read-only view of someone else's cloud project,
// reached through the public /api/cut-shared/<token>/* surface. The token is
// the share link's id. The viewer page binds one token before the editor
// mounts; the assistant's reference tools open a backend per link, so a
// share read never disturbs the one the viewer is showing. Reads only — a
// viewer never PUTs, so there is no write-conflict version map here; the
// version kept is the one the last doc actually delivered, which is what
// tells the change poll whether a reload landed.
import { cloudRequest } from "./cloud";
import type { CutBackend } from "./types";

let boundToken = "";

/** Bind the share link token before bindCutMode("shared"). */
export function bindSharedBackend(next: string) {
  boundToken = next;
}

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

/** A backend reading one share. The engine's route shapes rewrite under the
 * share's prefix; the bare prefix is the share's own meta route. The request
 * rides the cloud transport, so a headless process bound to a hosted origin
 * reaches the share the same way it reaches its own projects. */
export function sharedBackendFor(token: string): CutBackend {
  const prefix = `/api/cut-shared/${encodeURIComponent(token)}`;
  const sharedPath = (path: string) => {
    const rest = path.replace(/^\/api\/cut\/?/, "");
    return rest ? `${prefix}/${rest}` : prefix;
  };
  return {
    kind: "shared",
    caps: {
      importUrl: false,
      liveMic: false,
      transcribe: false,
      captionAi: false,
      revealInFinder: false,
      watch: false,
    },
    fetch: async (path, init) => {
      const res = await cloudRequest(sharedPath(path), init);
      const doc = PROJECT_DOC.exec(path);
      const method = (init?.method ?? "GET").toUpperCase();
      if (doc && method === "GET" && res.ok) {
        const version = res.headers.get("x-cut-doc-version");
        if (version) loadedVersions.set(decodeURIComponent(doc[1]), version);
      }
      return res;
    },
    url: (path) => sharedPath(path),
  };
}

/** The viewer page's backend: the token bound before the editor mounted. */
export const sharedBackend: CutBackend = {
  kind: "shared",
  caps: {
    importUrl: false,
    liveMic: false,
    transcribe: false,
    captionAi: false,
    revealInFinder: false,
    watch: false,
  },
  fetch: (path, init) => sharedBackendFor(boundToken).fetch(path, init),
  url: (path) => sharedBackendFor(boundToken).url(path),
};
