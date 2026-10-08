/**
 * How a letter looks mid-glitch, shared by the canvas painter and the DOM
 * preview so both tear a title into the same two copies.
 */

/** The channel copies a split letter shows either side of itself: red pulled
 * left, cyan pulled right, the letter itself on top. */
export const SPLIT_RED = "#FF2A55";
export const SPLIT_CYAN = "#00E5FF";

/** Whether a text color lays down no ink — an outline-only title's fill.
 * Its tinted copies keep the fill clear too, so a hollow title tears into
 * hollow copies. "transparent", "#RGB0", "#RRGGBB00" and a zero-alpha
 * rgba()/hsla() all count. */
export function isInkless(color: string): boolean {
  const c = color.trim().toLowerCase();
  if (c === "transparent") {
    return true;
  }
  if (/^#([0-9a-f]{3}0|[0-9a-f]{6}00)$/.test(c)) {
    return true;
  }
  return /^(rgba|hsla)\(.*[,/]\s*0(\.0*)?\s*\)$/.test(c);
}
