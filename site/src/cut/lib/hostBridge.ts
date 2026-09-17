"use client";

import { useEffect, useSyncExternalStore } from "react";
import { editorHost } from "@/cut/lib/environment";

/**
 * The ChatGPT card and the editor it frames talk over postMessage. The card
 * tells the frame which display mode the host is in and how tall the host's
 * bottom overlay is; the frame keeps its bottom controls and the timeline's
 * last rows above that band through `--host-inset-bottom`, and asks the card
 * for fullscreen from its own toolbar. Outside the card nothing is sent and
 * the variable stays unset.
 */
export type HostDisplayMode = "inline" | "fullscreen";

let displayMode: HostDisplayMode = "inline";
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const read = () => displayMode;
const readServer = (): HostDisplayMode => "inline";

export function useHostDisplayMode() {
  return useSyncExternalStore(subscribe, read, readServer);
}

export function requestHostFullscreen() {
  if (editorHost() !== "chatgpt") return;
  window.parent.postMessage({ type: "donkeycut:fullscreen" }, "*");
}

export function useHostBridge() {
  useEffect(() => {
    if (editorHost() !== "chatgpt") return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const data = event.data as { type?: unknown; insetBottom?: unknown; displayMode?: unknown } | null;
      if (data?.type !== "donkeycut:host") return;
      if (typeof data.insetBottom === "number") {
        const px = Math.max(0, Math.min(400, Math.round(data.insetBottom)));
        document.documentElement.style.setProperty("--host-inset-bottom", `${px}px`);
      }
      const mode: HostDisplayMode = data.displayMode === "fullscreen" ? "fullscreen" : "inline";
      if (mode !== displayMode) { displayMode = mode; listeners.forEach((l) => l()); }
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: "donkeycut:host?" }, "*");
    return () => window.removeEventListener("message", onMessage);
  }, []);
}
