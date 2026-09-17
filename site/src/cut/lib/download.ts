"use client";

import { openThroughHost, saveThroughHost } from "./hostBridge";

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

/**
 * Save a URL that already answers as an attachment. Framed inside the ChatGPT
 * card the page sits under a sandbox without `allow-downloads`, which blocks
 * every download a frame starts — so the host opens the link in a tab of its
 * own and the browser saves it there.
 */
export function downloadFile(href: string, name: string) {
  if (openThroughHost(href)) return;
  clickAnchor(window, href, name);
}

/** Save text made in this tab — a captions file — to the user's Downloads
 * folder. The blob is same-origin, so the anchor's own name is honored; inside
 * the card the text goes to the host, which has no origin to be blocked by. */
export function downloadText(text: string, name: string, type = "text/plain") {
  if (saveThroughHost(text, name, type)) return;
  const url = window.URL.createObjectURL(new Blob([text], { type }));
  clickAnchor(window, url, name);
  setTimeout(() => window.URL.revokeObjectURL(url), 10_000);
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
