"use client";

import { useSyncExternalStore } from "react";

// The right end of the ChatGPT card's tab bar, where the page on the open tab
// puts its actions, e.g. Assets' Upload. The bar mounts it only for a tab
// that has actions, so a page kept mounted behind another tab finds no slot
// and shows nothing there.
let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const read = () => slot;
const serverSlot = () => null;

/** The tab bar's ref for its actions slot: the element in, null on the way out. */
export function setCardTabSlot(el: HTMLElement | null) {
  slot = el;
  listeners.forEach((listener) => listener());
}

/** The slot to portal a page's actions into, or null when the bar has none. */
export function useCardTabSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, read, serverSlot);
}
