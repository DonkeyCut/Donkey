// A Cut backend is where a project lives and executes: "local" is the engine
// on this Mac (127.0.0.1, disk storage, native tools), "cloud" is the hosted
// deployment (session auth, Postgres + R2), "browser" is this page's own
// origin-private storage with AI riding the hosted twin, and "shared" is a
// read-only view of another account's cloud project through a share link. All
// speak the same JSON route shapes, so ordinary API calls dispatch through one
// transport; operations whose contracts genuinely differ (uploads, export,
// transcription) branch on the backend kind where they are implemented.
export type CutMode = "local" | "cloud" | "browser" | "shared";

// What the active backend can do. Components consult these to hide
// affordances instead of feature-detecting or failing at call time.
export type CutCaps = {
  /** Import media from a URL (yt-dlp on the engine; render worker later). */
  importUrl: boolean;
  /** Live mic dictation (engine cut-stt --live). */
  liveMic: boolean;
  /** Timeline transcription (engine cut-stt; hosted LLM STT later). */
  transcribe: boolean;
  /** Caption AI: translate, rewrite, visual subtitles (engine Claude-CLI one-shots). */
  captionAi: boolean;
  /** Reveal a media file in Finder. */
  revealInFinder: boolean;
  /** AI "watch" filmstrip contact sheets (engine ffmpeg). */
  watch: boolean;
};

/** Observational reads leave the next document save based on the loaded version. */
/** Who answers a storage refusal (413): the app-wide storage wall, or the
 * caller, which raises the wall its own way (an import raises one per drop). */
export type StorageFull = "wall" | "caller";

export type CutRequestInit = RequestInit & { observe?: boolean; storageFull?: StorageFull };

export interface CutBackend {
  kind: CutMode;
  caps: CutCaps;
  /** fetch() against this backend, preserving the engine route shapes. */
  fetch(path: string, init?: CutRequestInit): Promise<Response>;
  /** Absolute-or-relative URL for a backend API path (media src, downloads). */
  url(path: string): string;
}

/** Headers a cloud transport stamps on every project doc save: its writer id
 * (one per page load, headless session, or captured backend) and the save's
 * place in that writer's sequence. The server applies a save over a newer
 * version only when the same writer saved it earlier in the sequence. */
export const DOC_WRITER_HEADER = "x-cut-doc-writer";
export const DOC_SEQ_HEADER = "x-cut-doc-seq";

/** The status a versioned doc save answers when another writer moved on. */
export const HTTP_CONFLICT = 409;

/** The status a write answers when the account's storage has no room for it. */
export const HTTP_PAYLOAD_TOO_LARGE = 413;
