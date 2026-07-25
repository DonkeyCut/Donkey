// A Cut backend is where a project lives and executes: "local" is the engine
// on this Mac (127.0.0.1, disk storage, native tools), "cloud" is the hosted
// deployment (session auth, Postgres + R2), and "shared" is a read-only view
// of another account's cloud project through a share link. All speak the same
// JSON route shapes, so ordinary API calls dispatch through one transport;
// operations whose contracts genuinely differ (uploads, export,
// transcription) branch on the backend kind where they are implemented.
export type CutMode = "local" | "cloud" | "shared";

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
  /** Claude/Codex CLI chat providers (the user's own local logins). */
  localCliChat: boolean;
  /** Reveal a media file in Finder. */
  revealInFinder: boolean;
  /** AI "watch" filmstrip contact sheets (engine ffmpeg). */
  watch: boolean;
};

export interface CutBackend {
  kind: CutMode;
  caps: CutCaps;
  /** fetch() against this backend, preserving the engine route shapes. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Absolute-or-relative URL for a backend API path (media src, downloads). */
  url(path: string): string;
}
