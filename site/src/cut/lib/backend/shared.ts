// The shared backend: a read-only view of someone else's cloud project,
// reached through the public /api/cut-shared/<token>/* surface. The token is
// the share link's id; the viewer page binds it before the editor mounts.
// Reads only — the viewer never PUTs, so there is no version map here.
import type { CutBackend } from "./types";

let token = "";

/** Bind the share link token before setCutMode("shared"). */
export function bindSharedBackend(next: string) {
  token = next;
}

const sharedPath = (path: string) =>
  path.replace(/^\/api\/cut\//, `/api/cut-shared/${encodeURIComponent(token)}/`);

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
  fetch: (path, init) => fetch(sharedPath(path), init),
  url: (path) => sharedPath(path),
};
