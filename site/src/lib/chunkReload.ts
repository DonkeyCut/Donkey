// The error name the bundler's runtime gives a lazy chunk that failed to load.
const CHUNK_LOAD_ERROR = "ChunkLoadError";

// Where the tab remembers its last recovery reload, and how long one counts:
// a chunk that fails again inside the window is genuinely unreachable (the
// network is down), and reloading again would loop.
const RELOADED_AT_KEY = "donkey-chunk-reload-at";
const RELOAD_WINDOW_MS = 30_000;

interface ReloadWindow {
  addEventListener(type: "error", fn: (e: ErrorEvent) => void): void;
  addEventListener(type: "unhandledrejection", fn: (e: PromiseRejectionEvent) => void): void;
  location: { reload(): void };
  sessionStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
}

/**
 * Reload the page when a lazy chunk fails to load.
 *
 * A tab open across a deploy still asks for the old build's chunks, and once
 * those are gone the import rejects and the tree it was loading dies. A
 * reload fetches the current build, at most once per window; a tab whose
 * storage throws keeps the failure.
 */
export function reloadOnChunkError(win: ReloadWindow, now: () => number = Date.now): void {
  const recover = (error: unknown) => {
    if ((error as { name?: string } | null)?.name !== CHUNK_LOAD_ERROR) {
      return;
    }

    // Skip when this tab already reloaded for a chunk moments ago.
    try {
      const last = Number(win.sessionStorage.getItem(RELOADED_AT_KEY));
      if (last && now() - last < RELOAD_WINDOW_MS) {
        return;
      }
      win.sessionStorage.setItem(RELOADED_AT_KEY, String(now()));
    } catch {
      // Storage unavailable: no way to tell a first failure from a loop.
      return;
    }

    win.location.reload();
  };

  win.addEventListener("error", (e) => recover(e.error));
  win.addEventListener("unhandledrejection", (e) => recover(e.reason));
}
