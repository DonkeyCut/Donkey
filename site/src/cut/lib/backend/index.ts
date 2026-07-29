// The backend seam: every Cut API call dispatches through the active backend.
// The app runs local (the engine on this Mac) when the ConnectGate reached one,
// and in the cloud otherwise. Call sites keep the exact apiFetch/apiUrl/apiJson
// shapes they always had; only the import moved from ../api to this module.
//
// This module stays React-free: the engine binary compiles lib/types.ts, which
// imports apiUrl from here. React hooks live in ./hooks.
import { engineOrigin, servedFromEngine } from "../api";
import { cloudBackend } from "./cloud";
import { localBackend } from "./local";
import { sharedBackend } from "./shared";
import type { CutBackend, CutCaps, CutMode } from "./types";

export type { CutBackend, CutCaps, CutMode };
export { apiJson } from "../api";

// Two things decide the backend, and only one of them knows about a project.
// The gate probes this Mac for an engine and sets the *ambient* mode — what the
// projects home and library run against, before any project is open. A project
// that is open pins the mode to its own residency, which is a fact about that
// project and outranks the ambient guess. Both writers are async and race on
// load; pinning is what keeps the gate's later "an engine answered, so local"
// from dragging an open cloud project onto the engine, where its doc and media
// don't exist.
let ambient: CutMode = "local";
let pinned: CutMode | null = null;
const listeners = new Set<() => void>();

function settle(apply: () => void) {
  const before = cutMode();
  apply();
  if (cutMode() !== before) listeners.forEach((l) => l());
}

/** Set by the ConnectGate: where the app runs when no project is open. */
export function setCutMode(next: CutMode) {
  settle(() => {
    ambient = next;
  });
}

/** Pin the mode to an open project's residency, outranking the ambient mode
 * until `releaseCutMode`. */
export function bindCutMode(next: CutMode) {
  settle(() => {
    pinned = next;
  });
}

/** Drop the pin when the project closes; the ambient mode takes over again. */
export function releaseCutMode() {
  settle(() => {
    pinned = null;
  });
}

export function cutMode(): CutMode {
  return pinned ?? ambient;
}

/** Subscription feed for ./hooks' useSyncExternalStore. */
export function subscribeCutMode(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function getBackend(): CutBackend {
  const mode = cutMode();
  return mode === "cloud" ? cloudBackend : mode === "shared" ? sharedBackend : localBackend;
}

/**
 * Whether work can run on this Mac: the gate resolved the engine's origin, or
 * the page is served by it. Where a job *runs* is a separate question from
 * where the project's data lives — speech and encoding belong on the Mac
 * whenever the app is there, even for a cloud project, because it costs the
 * user nothing and answers faster. The result still lands through the
 * project's own backend, so where the work ran never decides where data goes.
 */
export function hasLocalCompute(): boolean {
  return servedFromEngine() || engineOrigin() !== "";
}

/**
 * Announce that the gate settled whether this Mac has an engine.
 *
 * The answer lives in api.ts's memoized origin, where React can't subscribe to
 * it, and binding the mode doesn't stand in for it: an engine that answers
 * leaves the ambient mode exactly where it started, so nothing would fire.
 * Screens that offer local work — creating a project on this Mac — appear on
 * this signal.
 */
export function announceLocalCompute() {
  listeners.forEach((l) => l());
}

/** fetch() against the active backend. */
export const apiFetch = (path: string, init?: RequestInit) => getBackend().fetch(path, init);

/** Absolute-or-relative URL for a backend API path. */
export const apiUrl = (path: string) => getBackend().url(path);
