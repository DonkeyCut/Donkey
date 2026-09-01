"use client";

/**
 * The modifiers a pointer holds, read the way the platform means them.
 *
 * Windows and Linux add to a selection with Ctrl. A Mac adds with ⌘ and keeps
 * Ctrl for the secondary click: ctrl-click arrives as button 0 with `ctrlKey`
 * set and opens the context menu, so reading it as "add" there would change
 * the selection under the menu that is opening.
 */

interface Mods {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey?: boolean;
}

/** Whether this machine's selection modifier is ⌘. Read once: it is the OS,
 * and it does not change under the page. */
export const APPLE_KEYS: boolean = (() => {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform ?? nav.platform ?? "");
})();

/** Whether this click adds to the selection instead of replacing it. */
export const additiveClickOn = (apple: boolean, e: Mods): boolean =>
  !!e.shiftKey || (apple ? e.metaKey : e.ctrlKey);

/** Whether this drag is asking for snapping to be held off. */
export const snapHeldOffOn = (apple: boolean, e: Mods): boolean => (apple ? e.metaKey : e.ctrlKey);

export const additiveClick = (e: Mods): boolean => additiveClickOn(APPLE_KEYS, e);
export const snapHeldOff = (e: Mods): boolean => snapHeldOffOn(APPLE_KEYS, e);
