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

// The frame remembers it is the card for the rest of its session, so a page
// it navigates to on its own (a project opened from its projects home) is
// still the card without the flag in its address.
const CARD_KEY = "cut-embed";

export function editorHost(): EditorHost {
  if (typeof window === "undefined" || window.self === window.top) return "web";
  if (new URLSearchParams(window.location.search).get("embed") === "chatgpt") {
    rememberCard();
    return "chatgpt";
  }
  return rememberedCard() ? "chatgpt" : "web";
}

function rememberCard() {
  try {
    if (sessionStorage.getItem(CARD_KEY) !== "chatgpt") sessionStorage.setItem(CARD_KEY, "chatgpt");
  } catch {
    // Storage blocked: the flag in the address is all the frame has.
  }
}

function rememberedCard(): boolean {
  try {
    return sessionStorage.getItem(CARD_KEY) === "chatgpt";
  } catch {
    return false;
  }
}

const subscribe = () => () => {};
const serverHost = (): EditorHost => "web";

/** The host as React state: the server and the first client render agree on
 * the web, and a framed page settles on ChatGPT right after hydration. */
export function useEnvironment() {
  const host = useSyncExternalStore(subscribe, editorHost, serverHost);
  return { host, chatgpt: host === "chatgpt" };
}

/** The kind of device the page is on. A phone gets the welcome sequence and
 * the plans, and the editor itself asks for a computer. */
export type FormFactor = "phone" | "computer";

// The browser's own answer where it gives one (Chromium's client hints), the
// user agent's mobile token everywhere else. Tablets count as computers.
function formFactor(): FormFactor {
  if (typeof navigator === "undefined") return "computer";
  const hinted = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile;
  if (hinted !== undefined) return hinted ? "phone" : "computer";
  return /iPhone|iPod|Android.+Mobile|Mobile.+Firefox/.test(navigator.userAgent) ? "phone" : "computer";
}

const serverFormFactor = (): FormFactor => "computer";

/** The form factor as React state: the server and the first client render
 * agree on a computer, and a phone settles right after hydration. */
export function useFormFactor(): FormFactor {
  return useSyncExternalStore(subscribe, formFactor, serverFormFactor);
}
