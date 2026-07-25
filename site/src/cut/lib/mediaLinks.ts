"use client";

// Keeps a loaded project's media links working in a long-lived tab. Cloud and
// shared projects hydrate their assets with signed R2 URLs that expire after a
// day, so a laptop that sleeps past the expiry wakes to a project whose every
// <video>/<img> source 403s. Two guards close that hole:
//
// - Eager refresh: when the tab becomes visible (or regains focus / network)
//   within an hour of the signed batch's expiry, the batch re-mints and the
//   store's asset URLs swap in place. Components and the preview engine both
//   key their elements off asset.url, so the swap heals them on render.
// - Failure retry: a media element error on a signed URL forces a re-mint;
//   an error on an API-route URL (whose 302 re-signs per request, so failures
//   there are transient) reloads the element with a capped backoff.
//
// The store marks the batch at load; a global capture-phase error listener
// watches DOM elements, and the preview engine reports its detached decoders
// through reportMediaElementError.
import { fetchSignedMediaUrls } from "./backend/cloud";
import { mediaUrl } from "./types";

const REFRESH_LEAD_MS = 60 * 60 * 1000; // start re-minting an hour before expiry
const FORCED_GAP_MS = 15_000; // min gap between failure-driven re-mints
const ELEMENT_RETRIES = 3;
const ELEMENT_RETRY_BASE_MS = 1_000;
const ATTEMPT_RESET_MS = 60_000; // an old failure streak doesn't cap a new one

let batch: { projectId: string; expiresAt: number } | null = null;
let refreshing: Promise<void> | null = null;
let lastForcedAt = 0;

/** Record the signed batch minted for the loaded project (null expiry = the
 * mint came back empty, so only self-healing route URLs are in play). */
export function markSignedBatch(projectId: string, expiresAt: number | null) {
  batch = expiresAt === null ? null : { projectId, expiresAt };
}

/** Re-mint the loaded project's signed URLs and swap them into the store.
 * Single-flight; skips while the batch is comfortably fresh unless forced. */
function refreshSignedUrls(force = false): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const b = batch;
    if (!b) return;
    if (!force && Date.now() < b.expiresAt - REFRESH_LEAD_MS) return;
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
    for (const a of st.assets) {
      urls.set(a.fileName, minted.urls.get(a.fileName) ?? mediaUrl(b.projectId, a.fileName));
    }
    st.applyMediaUrls(urls);
    if (minted.expiresAt !== null) b.expiresAt = minted.expiresAt;
    // A failed mint left every asset on route URLs, which re-sign per request
    // — nothing signed remains to track until the next load.
    else batch = null;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

const isSignedUrl = (src: string) => src.includes("X-Amz-Signature=");
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

/** A media element failed to load. Signed URLs re-mint the whole batch (the
 * store swap repoints every consumer); route URLs reload the element itself. */
export function reportMediaElementError(el: HTMLImageElement | HTMLMediaElement) {
  const src = el instanceof HTMLImageElement ? el.src : el.currentSrc || el.src;
  if (!src || src.startsWith("blob:") || src.startsWith("data:")) return;
  if (isSignedUrl(src)) {
    if (Date.now() - lastForcedAt < FORCED_GAP_MS) return;
    lastForcedAt = Date.now();
    void refreshSignedUrls(true);
    return;
  }
  if (!isCutApiUrl(src)) return;
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
    if (batch && Date.now() >= batch.expiresAt - REFRESH_LEAD_MS) void refreshSignedUrls();
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
