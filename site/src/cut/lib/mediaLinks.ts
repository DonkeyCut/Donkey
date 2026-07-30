"use client";

// Keeps a loaded project's media links working in a long-lived tab. Cloud and
// shared projects hydrate their assets with time-limited URLs, so a tab that
// outlives one holds a project whose every <video>/<img> source 403s. Three
// guards close that hole:
//
// - Scheduled refresh: a timer re-mints ahead of expiry while the tab is
//   visible. Lifetimes differ by a lot — a presigned R2 URL lasts a day, an
//   edge media token a few minutes — so the lead is a fraction of the lifetime
//   the mint reported rather than a fixed span.
// - Event refresh: becoming visible (or regaining focus / network) inside the
//   lead re-mints too, which is what catches a laptop waking from sleep with
//   every timer long since fired.
// - Failure retry: a media element error on a time-limited URL forces a
//   re-mint, and the element reloads on a capped backoff. Both matter: the
//   mint only heals a URL that really expired, and inside a signing window it
//   hands back the same string, so the reload is what clears an element that
//   failed for any other reason.
//
// A re-mint swaps the store's asset URLs in place. Components and the preview
// engine both key their elements off asset.url, so the swap heals them on
// render. The store marks the batch at load; a global capture-phase error
// listener watches DOM elements, and the preview engine reports its detached
// decoders through reportMediaElementError.
import { fetchSignedMediaUrls } from "./backend/cloud";
import { mediaUrl } from "./types";

/** Re-mint this far ahead of expiry, as a share of the whole lifetime, so a
 * five-minute token and a one-day one are both refreshed in good time. */
const REFRESH_LEAD_FRACTION = 1 / 3;
const MAX_REFRESH_LEAD_MS = 20 * 60 * 1000; // …and a long-lived one needn't by more
const MIN_REFRESH_LEAD_MS = 20_000; // …nor a short one by less
const FORCED_GAP_MS = 15_000; // min gap between failure-driven re-mints
const ELEMENT_RETRIES = 3;
const ELEMENT_RETRY_BASE_MS = 1_000;
const ATTEMPT_RESET_MS = 60_000; // an old failure streak doesn't cap a new one

let batch: { projectId: string; expiresAt: number; lead: number } | null = null;
let refreshing: Promise<void> | null = null;
let lastForcedAt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function leadFor(expiresAt: number): number {
  const lifetime = Math.max(0, expiresAt - Date.now());
  return Math.min(
    MAX_REFRESH_LEAD_MS,
    Math.max(MIN_REFRESH_LEAD_MS, lifetime * REFRESH_LEAD_FRACTION)
  );
}

/** Wake at the top of the lead window. A hidden tab skips the mint — the
 * visibility handler picks it up on return — so a backgrounded project isn't
 * re-minting on a loop nobody is watching. */
function scheduleRefresh() {
  if (timer) clearTimeout(timer);
  timer = null;
  const b = batch;
  if (!b) return;
  const wait = Math.max(0, b.expiresAt - b.lead - Date.now());
  timer = setTimeout(() => {
    timer = null;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    void refreshSignedUrls();
  }, wait);
}

/** Record the batch minted for the loaded project (null expiry = the mint came
 * back empty, so only self-healing route URLs are in play). */
export function markSignedBatch(projectId: string, expiresAt: number | null) {
  batch = expiresAt === null ? null : { projectId, expiresAt, lead: leadFor(expiresAt) };
  scheduleRefresh();
}

/** Re-mint the loaded project's signed URLs and swap them into the store.
 * Single-flight; skips while the batch is comfortably fresh unless forced. */
function refreshSignedUrls(force = false): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const b = batch;
    if (!b) return;
    if (!force && Date.now() < b.expiresAt - b.lead) return;
    const { useEditor } = await import("./store");
    const s = useEditor.getState();
    if (!s.loaded || s.projectId !== b.projectId) return;
    const minted = await fetchSignedMediaUrls(b.projectId, s.assets.map((a) => a.fileName));
    const st = useEditor.getState();
    if (batch !== b || st.projectId !== b.projectId || !st.loaded) return;
    // Mint down but the current URLs still work (inside the eager-refresh
    // lead, no element failure) — keep them; the next visibility/online
    // event retries.
    if (minted.urls.size === 0 && !force && Date.now() < b.expiresAt) return;
    const urls = new Map<string, string>();
    let rotated = 0;
    for (const a of st.assets) {
      const url = minted.urls.get(a.fileName) ?? mediaUrl(b.projectId, a.fileName);
      urls.set(a.fileName, url);
      if (url !== a.url) rotated++;
    }
    console.debug(
      `[cut-media] re-mint: ${rotated}/${st.assets.length} url(s) rotated` + (force ? " (forced by a load failure)" : "")
    );
    st.applyMediaUrls(urls);
    if (minted.expiresAt !== null) {
      b.expiresAt = minted.expiresAt;
      b.lead = leadFor(minted.expiresAt);
    }
    // A failed mint left every asset on route URLs, which re-sign per request
    // — nothing time-limited remains to track until the next load.
    else batch = null;
  })().finally(() => {
    refreshing = null;
    scheduleRefresh();
  });
  return refreshing;
}

/** A URL whose access expires and can be re-minted: an edge media token
 * (`?e=<expiry>&s=<signature>`). It heals by re-minting the batch; anything
 * else does not. */
function isExpiringUrl(src: string): boolean {
  try {
    const params = new URL(src, window.location.origin).searchParams;
    return params.has("e") && params.has("s");
  } catch {
    return false;
  }
}
const isCutApiUrl = (src: string) => src.includes("/api/cut");

const attempts = new WeakMap<Element, { n: number; at: number }>();

function retryElement(el: HTMLImageElement | HTMLMediaElement, src: string, attempt: number) {
  window.setTimeout(() => {
    if (el instanceof HTMLImageElement) {
      if (el.src !== src) return; // repointed since the failure
      el.removeAttribute("src");
      el.src = src;
    } else {
      if ((el.currentSrc || el.src) !== src) return;
      el.load();
    }
  }, ELEMENT_RETRY_BASE_MS * attempt);
}

/** A media element failed to load. An expiring URL may genuinely have expired,
 * so re-mint the whole batch — the store swap repoints every consumer. Then
 * reload the element either way: re-minting is not a cure on its own, because
 * a signed URL is stable for its whole signing window, so inside that window
 * the mint hands back the very string that just failed and no consumer
 * repoints. Reloading is what heals the ordinary failure — a range request
 * lost to a blip, a 403 that raced the re-mint — instead of leaving a dead
 * element on screen until the tab is reloaded. */
export function reportMediaElementError(el: HTMLImageElement | HTMLMediaElement) {
  const src = el instanceof HTMLImageElement ? el.src : el.currentSrc || el.src;
  if (!src || src.startsWith("blob:") || src.startsWith("data:")) return;
  const expiring = isExpiringUrl(src);
  if (expiring && Date.now() - lastForcedAt >= FORCED_GAP_MS) {
    lastForcedAt = Date.now();
    void refreshSignedUrls(true);
  }
  if (!expiring && !isCutApiUrl(src)) return;
  const rec = attempts.get(el) ?? { n: 0, at: 0 };
  if (Date.now() - rec.at > ATTEMPT_RESET_MS) rec.n = 0;
  if (rec.n >= ELEMENT_RETRIES) return;
  rec.n += 1;
  rec.at = Date.now();
  attempts.set(el, rec);
  retryElement(el, src, rec.n);
}

if (typeof window !== "undefined") {
  const maybeRefresh = () => {
    if (document.visibilityState !== "visible") return;
    if (!batch) return;
    if (Date.now() >= batch.expiresAt - batch.lead) void refreshSignedUrls();
    // Coming back to a tab whose timer fired while it was hidden: the mint is
    // still in the future, so re-arm rather than wait for an expiry that has
    // no wake-up left behind it.
    else if (!timer) scheduleRefresh();
  };
  document.addEventListener("visibilitychange", maybeRefresh);
  window.addEventListener("focus", maybeRefresh);
  window.addEventListener("online", maybeRefresh);
  // Error events don't bubble, but the capture phase still passes through
  // window for any element in the document — one listener covers every
  // rendered <video>/<img>. The preview engine's detached decoders report
  // themselves explicitly.
  window.addEventListener(
    "error",
    (e) => {
      const t = e.target;
      if (t instanceof HTMLImageElement || t instanceof HTMLMediaElement) {
        reportMediaElementError(t);
      }
    },
    true
  );
}
