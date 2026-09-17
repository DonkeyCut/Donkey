"use client";

import { useSyncExternalStore } from "react";

/**
 * Where the editor is running. The web is the editor on donkeycut.com; ChatGPT
 * is the same page framed inside the ChatGPT card, which arrives with
 * `?embed=chatgpt` and its own partitioned session. The card is the whole
 * surface there, so chrome that belongs to the site (navigation, credits,
 * recording, downloads, the assistant) stays out of the frame.
 */
export type EditorHost = "web" | "chatgpt";

export function editorHost(): EditorHost {
  if (typeof window === "undefined" || window.self === window.top) return "web";
  return new URLSearchParams(window.location.search).get("embed") === "chatgpt" ? "chatgpt" : "web";
}

const subscribe = () => () => {};
const serverHost = (): EditorHost => "web";

/** The host as React state: the server and the first client render agree on
 * the web, and a framed page settles on ChatGPT right after hydration. */
export function useEnvironment() {
  const host = useSyncExternalStore(subscribe, editorHost, serverHost);
  return { host, chatgpt: host === "chatgpt" };
}
