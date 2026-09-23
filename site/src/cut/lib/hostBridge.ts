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
 *
 * The frame also asks the card for the two things a sandboxed frame cannot do
 * itself: open a page in a tab of its own, and save a file. ChatGPT sandboxes
 * the card without `allow-downloads`, and a popup opened from inside inherits
 * that sandbox, so the host has to carry both.
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

/**
 * Open a page in a tab the host owns. Answers whether the host took it, so a
 * caller on the web falls through to its own navigation.
 */
export function openThroughHost(url: string): boolean {
  if (editorHost() !== "chatgpt") return false;
  window.parent.postMessage(
    { type: "donkeycut:open", url: new URL(url, window.location.href).toString() },
    "*"
  );
  return true;
}

/** Open a page in a new tab: through the host inside the card, where the
 * sandbox blocks a popup, and straight from the page everywhere else. */
export function openExternal(url: string) {
  if (openThroughHost(url)) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Save text made in the frame — a captions file — through the host. */
export function saveThroughHost(text: string, name: string, mimeType: string): boolean {
  if (editorHost() !== "chatgpt") return false;
  window.parent.postMessage({ type: "donkeycut:save", text, name, mimeType }, "*");
  return true;
}

/**
 * The card draws the editor's skeleton over the frame until the frame says
 * there is something to see: the editor, or why it cannot open. A crash
 * reaches the page as an uncaught error and replaces whatever was loading, so
 * it shows the frame too.
 */
const announceReady = () => window.parent.postMessage({ type: "donkeycut:ready" }, "*");
if (typeof window !== "undefined" && editorHost() === "chatgpt") window.addEventListener("error", announceReady);

export function useHostReady(ready: boolean) {
  useEffect(() => {
    if (ready && editorHost() === "chatgpt") announceReady();
  }, [ready]);
}

/** The project on donkeycut.com: this page without the frame's embed flag. */
export function projectPageUrl(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete("embed");
  return url.toString();
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
