import { describe, expect, test } from "bun:test";
import { isDeleteKey, tellingKey, textEntryOf, typingOf } from "./shortcutGate";

const key = (k: string, code = "", mods: Partial<KeyboardEvent> = {}) =>
  ({ key: k, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

describe("what holds a keystroke", () => {
  test("text fields hold it, toggles and sliders do not", () => {
    expect(typingOf({ tagName: "TEXTAREA" })).toBe(true);
    expect(typingOf({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(typingOf({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(typingOf({ tagName: "INPUT", type: "range" })).toBe(false);
    expect(typingOf({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(typingOf({ tagName: "DIV" })).toBe(false);
  });

  test("a select keeps the keys and lets the focus go", () => {
    // The arrows pick its value, so the shortcuts stand aside; picking is over
    // the moment it is picked, so an import may take the keyboard back.
    expect(textEntryOf({ tagName: "SELECT" })).toBe(true);
    expect(typingOf({ tagName: "SELECT" })).toBe(false);
  });
});

describe("the delete keystroke", () => {
  test("backspace and delete both clear the selection", () => {
    expect(isDeleteKey(key("Backspace"))).toBe(true);
    expect(isDeleteKey(key("Delete"))).toBe(true);
  });

  test("a numeric pad's Delete key counts, Num Lock either way", () => {
    // Num Lock off sends the name, on sends the decimal point; the keycap
    // says Delete for both.
    expect(isDeleteKey(key("Delete", "NumpadDecimal"))).toBe(true);
    expect(isDeleteKey(key(".", "NumpadDecimal"))).toBe(true);
  });

  test("a decimal point typed anywhere else is a decimal point", () => {
    expect(isDeleteKey(key(".", "Period"))).toBe(false);
  });

  test("held with a modifier the numpad chord belongs to the browser", () => {
    expect(isDeleteKey(key(".", "NumpadDecimal", { metaKey: true }))).toBe(false);
    expect(isDeleteKey(key(".", "NumpadDecimal", { ctrlKey: true, altKey: true }))).toBe(false);
  });
});

describe("what a decline is worth reporting", () => {
  test("only the chords the editor binds, which no typing holds", () => {
    expect(tellingKey(key("b", "KeyB", { ctrlKey: true }))).toBe(true);
    expect(tellingKey(key("j", "KeyJ", { metaKey: true }))).toBe(true);
    expect(tellingKey(key("b", "KeyB"))).toBe(false);
    expect(tellingKey(key("Delete"))).toBe(false);
    expect(tellingKey(key("Backspace"))).toBe(false);
    expect(tellingKey(key(" ", "Space"))).toBe(false);
  });

  test("AltGr is not a chord — it is how a Brazilian layout types", () => {
    expect(tellingKey(key("b", "KeyB", { ctrlKey: true, altKey: true }))).toBe(false);
  });
});
