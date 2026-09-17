"use client";

import { useEffect } from "react";
import { editorHost } from "@/cut/lib/environment";

/**
 * Framed inside the ChatGPT card, the editor sits under the host's composer
 * in fullscreen. The card tells the frame how tall that band is, and the
 * editor keeps its bottom controls and the timeline's last rows above it
 * through `--host-inset-bottom`. Outside the card the variable stays unset.
 */
export function useHostInset() {
  useEffect(() => {
    if (editorHost() !== "chatgpt") return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const data = event.data as { type?: unknown; insetBottom?: unknown } | null;
      if (data?.type !== "donkeycut:host-inset" || typeof data.insetBottom !== "number") return;
      const px = Math.max(0, Math.min(400, Math.round(data.insetBottom)));
      document.documentElement.style.setProperty("--host-inset-bottom", `${px}px`);
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: "donkeycut:host-inset?" }, "*");
    return () => window.removeEventListener("message", onMessage);
  }, []);
}
