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
  const a = document.createElement("a");
  a.href = `${url}${url.includes("?") ? "&" : "?"}download=1`;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Save text made in this tab — a captions file — to the user's Downloads
 * folder. The blob is same-origin, so the anchor's own name is honored. */
export function downloadText(text: string, name: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
