// The local backend: the engine on this Mac. A pass-through to the existing
// engine transport in ../api, so request shapes are exactly what they were
// before the backend seam existed.
import { apiFetch, apiUrl } from "../api";
import type { CutBackend } from "./types";

export const localBackend: CutBackend = {
  kind: "local",
  caps: {
    importUrl: true,
    liveMic: true,
    transcribe: true,
    captionAi: true,
    revealInFinder: true,
    watch: true,
  },
  fetch: (path, init) => apiFetch(path, init),
  url: (path) => apiUrl(path),
};
