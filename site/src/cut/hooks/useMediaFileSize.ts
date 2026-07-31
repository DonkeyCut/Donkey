"use client";

import { useEffect, useState } from "react";

/** One lookup per URL for the whole session; every card showing the same file
 * shares the result. */
const sizes = new Map<string, Promise<number | null>>();

function headSize(url: string): Promise<number | null> {
  let p = sizes.get(url);
  if (!p) {
    p = fetch(url, { method: "HEAD" })
      .then((res) => {
        const n = Number(res.headers.get("Content-Length"));
        return res.ok && Number.isFinite(n) && n > 0 ? n : null;
      })
      .catch(() => null);
    sizes.set(url, p);
  }
  return p;
}

/**
 * A served media file's size in bytes, read from a HEAD request's
 * Content-Length — the servers already know every file's size, so no size
 * field has to ride the document. Fetches nothing until `active` turns true
 * (the card's first hover); null until known, or when the server won't say.
 */
export function useMediaFileSize(url: string, active: boolean): number | null {
  const [size, setSize] = useState<number | null>(null);
  useEffect(() => {
    if (!active || !url) return;
    let live = true;
    void headSize(url).then((n) => {
      if (live) setSize(n);
    });
    return () => {
      live = false;
    };
  }, [url, active]);
  return size;
}
