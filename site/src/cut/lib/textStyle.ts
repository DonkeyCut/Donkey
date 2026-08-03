// What a title's look is made of lives with the element model; this module is
// about remembering one across clips and projects so repeated titles share it.
export type { TextStyle } from "@donkeycut/effects-kit";
import type { TextStyle } from "@donkeycut/effects-kit";

const KEY = "cut-text-style";

export function readTextStyle(): Partial<TextStyle> {
  if (typeof localStorage === "undefined") return {};
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as Partial<TextStyle>) : {};
  } catch {
    return {};
  }
}

export function writeTextStyle(style: Partial<TextStyle>) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(style));
  } catch {
    // Storage full/blocked — the style just won't persist.
  }
}
