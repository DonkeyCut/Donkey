"use client";

import { track } from "@/lib/analytics";

/**
 * Who a keystroke belongs to.
 *
 * The editor is played from the keyboard — space plays, ⌫ deletes, ⌘B cuts —
 * and every one of those keys is also a key someone types with. So the
 * shortcut layer stands aside whenever a text field holds the keystroke, a
 * dialog is on top, or the view refuses edits. Each of those is a silent
 * return, and a keyboard that has quietly stopped working leaves nothing
 * behind to read. This module is the one place that decides, and the one place
 * that says so out loud.
 */

/** Why the editor left a keystroke alone. */
export type ShortcutDecline = "typing" | "dialog" | "read-only";

/** The part of an element that decides whether keys belong to it. */
export interface Keyed {
  tagName: string;
  type?: string;
  isContentEditable?: boolean;
}

/** Input types that hold no text, so a key over one is the editor's. */
const NON_TEXT_INPUTS = ["checkbox", "radio", "range", "button", "file"];

/** Whether someone is mid-sentence in this element. */
export const typingOf = (el: Keyed): boolean =>
  el.tagName === "TEXTAREA" ||
  el.isContentEditable === true ||
  (el.tagName === "INPUT" && !NON_TEXT_INPUTS.includes(el.type ?? ""));

/** Whether the editor's keys belong to this element: typing, and a native
 * select besides — the arrows pick its value. */
export const textEntryOf = (el: Keyed): boolean => el.tagName === "SELECT" || typingOf(el);

const keyed = (el: EventTarget | null): Keyed | null =>
  el instanceof HTMLElement
    ? {
        tagName: el.tagName,
        type: (el as HTMLInputElement).type,
        isContentEditable: el.isContentEditable,
      }
    : null;

/** Whether this element holds the keystroke. */
export function isTextEntry(el: EventTarget | null): boolean {
  const k = keyed(el);
  return k !== null && textEntryOf(k);
}

/** Whether a sentence is being written here, so moving the focus away would
 * interrupt it. A select is done being picked the moment it is picked. */
export function isTyping(el: EventTarget | null): boolean {
  const k = keyed(el);
  return k !== null && typingOf(k);
}

/** Whether a paste belongs to this element. Broader than the keys: a control
 * of any kind keeps its own paste. */
export const isPasteTarget = (el: EventTarget | null): boolean =>
  el instanceof HTMLElement &&
  (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

/**
 * Whether a dialog stands over the editor, which owns the keyboard while it is
 * open. A popup keeps its element through its exit animation, and on a machine
 * dropping frames that runs long; Base UI marks those `data-closed`, and a
 * dialog on its way out has no claim on the keys.
 */
export function dialogOnTop(): boolean {
  for (const el of document.querySelectorAll('[data-slot="dialog-content"]')) {
    if (!el.hasAttribute("data-closed")) return true;
  }
  return false;
}

/** Null when the keystroke is the editor's, otherwise who took it. */
export function shortcutDecline(
  e: KeyboardEvent,
  opts: { exportOpen?: boolean } = {}
): ShortcutDecline | null {
  if (isTextEntry(e.target)) return "typing";
  if (opts.exportOpen || dialogOnTop()) return "dialog";
  return null;
}

/**
 * Whether this keystroke asks for the selection to go.
 *
 * A laptop numeric pad labels its own decimal key Delete and sends `.` for it
 * while Num Lock is on. It counts on its own: with a modifier down the chord
 * belongs to the browser or the OS.
 */
export const isDeleteKey = (e: KeyboardEvent): boolean =>
  e.key === "Backspace" ||
  e.key === "Delete" ||
  (e.code === "NumpadDecimal" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey);

/**
 * Keys worth reporting a decline for. A chord the editor binds — ⌘B, ⌘J, ⌘G —
 * is one no text field wants, so a run of them going nowhere is the editor's
 * keyboard being held. Every bare key stays out: ⌫, Delete, space, the arrows
 * and the letters are what typing is made of, and a field turns them down all
 * day by design.
 */
const TELLING_MOD = "bjg";

export const tellingKey = (e: KeyboardEvent): boolean => {
  const k = e.key.toLowerCase();
  return (e.metaKey || e.ctrlKey) && !e.altKey && k.length === 1 && TELLING_MOD.includes(k);
};

// A run of declines. One chord turned down is nothing; a run of them with not
// one keystroke reaching the editor in between is a keyboard someone is
// pressing at a surface that has stopped listening. The run resets the moment
// a keystroke gets through, so a page that goes deaf halfway still reports.
let seen = 0;
let declined = 0;
let said = false;
/** Declines in a row before the keyboard is called stuck: few enough that the
 * person is still at it wondering why nothing happens, enough that one chord
 * over a panel stays quiet. */
export const STUCK_AFTER = 3;

/** A keydown reached the editor's handler. */
export function noteKey(): void {
  seen++;
}

/** A keystroke got through to the editor's shortcuts. */
export function shortcutReached(): void {
  declined = 0;
}

/**
 * Record that the editor turned a bound chord down, and report a run of them
 * once — the whole page load's one word on a keyboard going nowhere.
 */
export function reportDecline(reason: ShortcutDecline, e: KeyboardEvent): void {
  // A share view refuses edits by design; its declines are the feature.
  if (reason === "read-only" || !tellingKey(e)) return;
  declined++;
  if (said || declined < STUCK_AFTER) return;
  said = true;
  const el = e.target instanceof HTMLElement ? e.target : null;
  track("cut_keyboard_blocked", {
    reason,
    seen,
    declined,
    key: `mod+${e.key.toLowerCase()}`,
    tag: el?.tagName ?? "",
    slot: el?.dataset.slot ?? "",
  });
}
