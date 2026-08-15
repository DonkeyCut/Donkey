// The browser backend: projects whose truth is this page's own origin-private
// storage. Storage routes are answered in-page by the browser router; AI and
// compute ride the hosted twin, metered like cloud projects. This module is
// compiled into the engine binary with the rest of backend/, so the router and
// store load through a function-scoped dynamic import and nothing here touches
// the DOM at module scope.
import { registeredUrl } from "./browser/registry";
import type { CutBackend } from "./types";

const cloudPath = (path: string) => path.replace(/^\/api\/cut\//, "/api/cut-cloud/");

async function browserFetch(path: string, init?: RequestInit): Promise<Response> {
  const { dispatchBrowserRoute } = await import("./browser/router");
  const owned = await dispatchBrowserRoute(path, init);
  return owned ?? fetch(cloudPath(path), init);
}

export const browserBackend: CutBackend = {
  kind: "browser",
  caps: {
    importUrl: false, // needs a machine that can run the fetch
    liveMic: true, // hosted LLM STT (lib/cloudTranscribe.ts)
    transcribe: true, // hosted LLM STT (lib/cloudTranscribe.ts)
    captionAi: true, // hosted Gemini twin (server/cloud/captions.ts)
    revealInFinder: false,
    watch: true, // browser seek + canvas contact sheets (lib/media.ts)
  },
  fetch: (path, init) => browserFetch(path, init),
  url: (path) => {
    // The registry is keyed by the bare API path; the blob URL it minted
    // carries the whole file, so query flags (?download) have nothing to
    // modify. Unregistered paths fall through to the hosted twin — AI routes
    // and the window before hydration re-registers the store.
    const q = path.indexOf("?");
    return registeredUrl(q === -1 ? path : path.slice(0, q)) ?? cloudPath(path);
  },
};
