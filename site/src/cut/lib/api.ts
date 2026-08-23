// Cut's client reaches its engine two ways. Served locally (cut.localhost,
// localhost) the page and the engine share an origin, so paths stay relative.
// Served from the hosted domain (donkeycut.com) the page is just static
// html/js — the Cut APIs are switched off on that host — so every API call
// targets the engine running on this Mac instead. Loopback is a trustworthy
// origin, so the https page may call it; the engine grants the hosted origin
// CORS (see src/proxy.ts).
//
// The mapping is fixed, with no fallback. A hosted page reaches exactly one
// engine — the release app's, on its loopback port — by health-probing that
// single origin; it never tries another port. A local page stays same-origin,
// so its own dev server answers in-process. A dev Donkey app runs its engine on
// its own port (DonkeyCutEnginePort) for that local surface, never reached from
// the hosted page. The resolved origin is remembered for the session.
import { DEFAULT_ENGINE_PORT } from "./ports";

// The one engine the hosted page talks to: the release app's, on this Mac's
// loopback. No probe list and no override — the page reaches this engine or
// fails visibly, never silently binding a different one.
const RELEASE_ENGINE_ORIGIN = `http://127.0.0.1:${DEFAULT_ENGINE_PORT}`;
const PROBE_TIMEOUT_MS = 1200;
// A first-ever loopback fetch from the hosted page hangs on the browser's
// local-network permission prompt until the user answers it; the connect
// probe waits that decision out instead of racing the health timeout.
const CONNECT_TIMEOUT_MS = 30_000;

const isLocalHost = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost");

/** Whether the page is served by the engine itself (same origin, so loopback
 * API calls need no browser permission). */
export const servedFromEngine = () =>
  typeof window !== "undefined" && isLocalHost(window.location.hostname);

let resolvedOrigin: string | null = null; // "" = same origin
let resolving: Promise<string> | null = null;

// The ConnectGate renders the app blurred behind its connect modal, so app
// code mounts — and starts requesting — before the user has agreed to the
// connection. This latch makes an early loopback touch impossible by
// construction: engineReady (and with it every apiFetch) waits here until the
// gate opens, and only the gate's own probes (engineProbe, engineConnect)
// bypass it.
let openGate: () => void = () => {};
let gateOpened = new Promise<void>((resolve) => {
  openGate = resolve;
});

/** Called by the ConnectGate once the engine answered; releases every waiting
 * engineReady/apiFetch. */
export function engineGateOpen() {
  openGate();
}

/** Fired on window when the engine stops answering mid-session; the
 * ConnectGate listens and puts its connect modal back up. */
export const ENGINE_LOST_EVENT = "cut-engine-lost";

/** Drop the resolved engine, close the gate latch, and notify the gate. Data
 * layers call this when engine requests start failing after a successful
 * connect. */
export function engineLost() {
  resolvedOrigin = null;
  gateOpened = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  window.dispatchEvent(new Event(ENGINE_LOST_EVENT));
}

/** Whether an engine is connected right now. Reads that would otherwise fire
 * at this Mac ask first, so a closed app costs no request. */
export const engineConnected = () => servedFromEngine() || resolvedOrigin !== null;

/** Whether this URL is served by the engine on this Mac. Loopback is the test
 * rather than the resolved origin, because the question is asked after the
 * connection is dropped, when there is no origin left to compare against. */
export function isEngineUrl(url: string): boolean {
  try {
    return isLocalHost(
      new URL(url, typeof window === "undefined" ? undefined : window.location.href).hostname
    );
  } catch {
    return false;
  }
}

let confirming: Promise<boolean> | null = null;

/**
 * Ask whether the engine is still there, and drop the connection when it is
 * not.
 *
 * A request that failed at the transport layer can't tell an app that quit
 * from one request that lost its way — the browser reports both as a fetch
 * that never landed. So the failure asks the health endpoint instead of
 * guessing, and one answer settles it for every caller waiting on the same
 * question.
 */
export function confirmEngine(): Promise<boolean> {
  if (!engineConnected()) return Promise.resolve(false);
  confirming ??= probe(resolvedOrigin ?? "")
    .then((ok) => {
      if (!ok) engineLost();
      return ok;
    })
    .finally(() => {
      confirming = null;
    });
  return confirming;
}

async function probe(origin: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  try {
    const res = await fetch(`${origin}/api/cut/engine/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** The hosted page's first connection to this Mac, run from the connect
 * screen's button so the browser's permission prompt lands in context. Probes
 * like engineReady but gives the user time to answer the prompt. Resolves
 * false when no engine answered; the gate stays on its install screen. */
export async function engineConnect(): Promise<boolean> {
  if (resolvedOrigin !== null) return true;
  if (servedFromEngine()) {
    resolvedOrigin = "";
    return true;
  }
  if (await probe(RELEASE_ENGINE_ORIGIN, CONNECT_TIMEOUT_MS)) {
    resolvedOrigin = RELEASE_ENGINE_ORIGIN;
    return true;
  }
  return false;
}

/** Resolve (and memoize) the engine origin without waiting on the gate latch
 * — the ConnectGate's own quiet probe. Throws when no engine answers; a
 * failed attempt is not memoized, so the next call probes again. */
export function engineProbe(): Promise<string> {
  if (resolvedOrigin !== null) return Promise.resolve(resolvedOrigin);
  resolving ??= (async () => {
    if (typeof window === "undefined" || isLocalHost(window.location.hostname)) {
      resolvedOrigin = "";
      return "";
    }
    if (await probe(RELEASE_ENGINE_ORIGIN)) {
      resolvedOrigin = RELEASE_ENGINE_ORIGIN;
      return RELEASE_ENGINE_ORIGIN;
    }
    throw new Error("No Donkey Cut engine is reachable on this Mac.");
  })().finally(() => {
    resolving = null;
  });
  return resolving;
}

/** Resolve the engine for app code: waits for the ConnectGate to open first,
 * so nothing outside the gate can be the first to touch loopback. */
export async function engineReady(): Promise<string> {
  await gateOpened;
  return engineProbe();
}

/** The engine origin as currently known ("" while same-origin or unresolved).
 * URLs built from it are correct once any apiFetch has succeeded. */
export function engineOrigin(): string {
  return resolvedOrigin ?? "";
}

// The signed-in Donkey account, set by RequireSession once the session
// resolves. Every engine URL carries it (the `u` param) — headers can't,
// because media loads as plain <video>/<img> src. Local data is shared by every
// account on the Mac, so current engines ignore the param; engines released
// before 2026-08 refuse data requests without it, which is why the page keeps
// sending it.
//
// It is observable because the app shell paints before the session is known:
// the surfaces that read the engine subscribe through useEngineUser and hold a
// skeleton until an id is here, so an unscoped read has no moment to happen in.
let engineUser: string | null = null;
const listeners = new Set<() => void>();

export function setEngineUser(id: string) {
  if (engineUser === id) return;
  engineUser = id;
  try {
    localStorage.setItem(REMEMBERED_USER_KEY, id);
  } catch {
    // Private mode or headless: the next visit waits on the session as before.
  }
  for (const fn of listeners) fn();
}

const REMEMBERED_USER_KEY = "cut:user";

/** The account that was signed in here last time. RequireSession binds it on
 * boot so the surfaces paint their cached snapshots while the live session
 * request is still in flight; the resolved session then confirms or replaces
 * it. Cookies decide identity on every server read, so a stale id costs a
 * wrong-keyed cache miss and nothing else. */
export function rememberedEngineUser(): string | null {
  try {
    return localStorage.getItem(REMEMBERED_USER_KEY);
  } catch {
    return null;
  }
}

/** Called on sign-out, so the next visitor to this browser starts unbound. */
export function forgetRememberedEngineUser(): void {
  try {
    localStorage.removeItem(REMEMBERED_USER_KEY);
  } catch {
    // Nothing stored where nothing can be read.
  }
}

/** The bound account, or null before the session resolves. Client-side caches
 * scope their keys to it so two accounts sharing a browser can't read each
 * other's snapshots. */
export function currentEngineUser(): string | null {
  return engineUser;
}

/** Called when the bound account changes; returns its own unsubscribe. */
export function subscribeEngineUser(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const scopedPath = (path: string) =>
  engineUser
    ? `${path}${path.includes("?") ? "&" : "?"}u=${encodeURIComponent(engineUser)}`
    : path;

/** Absolute-or-relative URL for an engine API path. */
export const apiUrl = (path: string) => `${engineOrigin()}${scopedPath(path)}`;

/** fetch() against the engine, resolving it first. */
export async function apiFetch(path: string, init?: RequestInit) {
  const base = await engineReady();
  return fetch(`${base}${scopedPath(path)}`, init);
}

/** Whether a reply came from the engine on this Mac. The hosted API and the
 * in-page browser router answer the same `/api/cut/*` paths through their own
 * drivers, so the origin — or, when the engine serves the page itself, the
 * prefix the cloud driver rewrites away — is what separates them. */
function fromEngine(res: Response): boolean {
  if (!res.url) return false; // a Response the browser router built in-page
  const origin = engineOrigin();
  if (origin) return res.url.startsWith(`${origin}/`);
  if (!servedFromEngine()) return false;
  try {
    return new URL(res.url).pathname.startsWith("/api/cut/");
  } catch {
    return false;
  }
}

/** JSON body of a backend reply. A reply that never reached a handler is plain
 * text — a 404/405 from a build older than the route, a 403 refusal — so a
 * non-JSON body folds into an `error` message instead of throwing a
 * SyntaxError at the caller's parse. Only the engine can be behind the page it
 * is driving: it updates when the user updates the Donkey app, while the
 * hosted API ships with the page, so only an engine reply asks for an update. */
export async function apiJson<T>(res: Response): Promise<T & { error?: string }> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T & { error?: string };
  } catch {
    const engine = fromEngine(res);
    const stale = res.status === 404 || res.status === 405;
    return {
      error:
        stale && engine
          ? "The Donkey app on this Mac doesn't support this yet — update Donkey and try again."
          : stale
            ? "Donkey doesn't support this yet."
            : text.trim() || `The ${engine ? "engine" : "server"} replied ${res.status}.`,
    } as T & { error?: string };
  }
}
