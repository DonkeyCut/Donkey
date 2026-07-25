// The backend seam: every Cut API call dispatches through the active backend.
// The app runs local (the engine on this Mac) unless the ConnectGate put it in
// cloud mode — web mode with no engine present, behind the `cut-web-mode`
// flag. Call sites keep the exact apiFetch/apiUrl/apiJson shapes they always
// had; only the import moved from ../api to this module.
//
// This module stays React-free: the engine binary compiles lib/types.ts, which
// imports apiUrl from here. React hooks live in ./hooks.
import { cloudBackend } from "./cloud";
import { localBackend } from "./local";
import { sharedBackend } from "./shared";
import type { CutBackend, CutCaps, CutMode } from "./types";

export type { CutBackend, CutCaps, CutMode };
export { apiJson } from "../api";

let mode: CutMode = "local";
const listeners = new Set<() => void>();

/** Set by the ConnectGate before the app's data layer runs. */
export function setCutMode(next: CutMode) {
  if (mode === next) return;
  mode = next;
  listeners.forEach((l) => l());
}

export function cutMode(): CutMode {
  return mode;
}

/** Subscription feed for ./hooks' useSyncExternalStore. */
export function subscribeCutMode(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function getBackend(): CutBackend {
  return mode === "cloud" ? cloudBackend : mode === "shared" ? sharedBackend : localBackend;
}

/** fetch() against the active backend. */
export const apiFetch = (path: string, init?: RequestInit) => getBackend().fetch(path, init);

/** Absolute-or-relative URL for a backend API path. */
export const apiUrl = (path: string) => getBackend().url(path);
