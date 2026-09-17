"use client";

/**
 * Save a served media file to the user's Downloads folder.
 *
 * The `download=1` flag is what turns the URL into a download: both backends
 * answer it with an attachment disposition, which is the only thing that works
 * here. The anchor's own `download` attribute is ignored cross-origin, and
 * every media URL this app hands out is cross-origin to the page — the engine
 * on localhost, the cloud's 302 to the media host.
 */
export function downloadFromUrl(url: string, name: string) {
  downloadFile(`${url}${url.includes("?") ? "&" : "?"}download=1`, name);
}

/** Save a URL that already answers as an attachment. */
export function downloadFile(href: string, name: string) {
  const scope = downloadScope();
  clickAnchor(scope.window, href, name);
  scope.done();
}

/** Save text made in this tab — a captions file — to the user's Downloads
 * folder. The blob is same-origin, so the anchor's own name is honored. */
export function downloadText(text: string, name: string, type = "text/plain") {
  const scope = downloadScope();
  const url = scope.window.URL.createObjectURL(new scope.window.Blob([text], { type }));
  clickAnchor(scope.window, url, name);
  setTimeout(() => scope.window.URL.revokeObjectURL(url), 10_000);
  scope.done();
}

/**
 * Framed inside the ChatGPT card, the page sits under a sandbox without
 * `allow-downloads`, which blocks every download a frame starts, nested
 * frames included. A popup escapes that sandbox and, opened blank, inherits
 * this origin, so the anchor is clicked in there and the popup closes once
 * the download has started.
 */
function downloadScope(): { window: Window & typeof globalThis; done: () => void } {
  const popup = window.self !== window.top ? window.open("", "_blank") : null;
  if (!popup) return { window, done: () => {} };
  return { window: popup as Window & typeof globalThis, done: () => setTimeout(() => popup.close(), 1000) };
}

function clickAnchor(win: Window, href: string, name: string) {
  const a = win.document.createElement("a");
  a.href = href;
  a.download = name;
  a.rel = "noopener";
  win.document.body.appendChild(a);
  a.click();
  a.remove();
}
