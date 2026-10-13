import { describe, expect, test } from "bun:test";
import { pickTextStyle } from "@donkeycut/effects-kit";
import { styleMatches } from "./stylePresets";
import type { TextOverlay } from "./types";

// The inspector rings the saved style a title wears and offers to update one
// once the title's look moves off every saved style.

const title = (extra: Partial<Pick<TextOverlay, "text" | "x" | "y" | "size" | "italic">>): TextOverlay => ({
  id: "a",
  kind: "text",
  text: "I QUIT MY JOB",
  start: 0,
  end: 3,
  x: 0.5,
  y: 0.25,
  size: 110,
  font: "Anton",
  weight: 900,
  shadow: false,
  plate: false,
  color: "#FFFDE8",
  ...extra,
});

describe("styleMatches", () => {
  test("a title wears the style it was given, whatever its words and place", () => {
    const style = pickTextStyle(title({}));
    expect(styleMatches(style, title({ text: "Other", x: 0.1, y: 0.9 }))).toBe(true);
  });

  test("a style read back from storage drops unset fields and still matches", () => {
    const stored = JSON.parse(JSON.stringify(pickTextStyle(title({}))));
    expect(styleMatches(stored, title({}))).toBe(true);
  });

  test("a changed style field moves the title off the style", () => {
    const style = pickTextStyle(title({}));
    expect(styleMatches(style, title({ size: 96 }))).toBe(false);
    expect(styleMatches(style, title({ italic: true }))).toBe(false);
  });

  test("a style read back with its nested keys reordered still matches", () => {
    // A cloud shelf stores the carrier in jsonb, which hands objects back
    // in its own key order.
    const worn = title({});
    const own = { ...worn, shadow: { color: "#000000", blur: 12, x: 0, y: 4 } } as unknown as TextOverlay;
    const stored = { ...pickTextStyle(own), shadow: { y: 4, x: 0, blur: 12, color: "#000000" } };
    expect(styleMatches(stored as never, own)).toBe(true);
    expect(styleMatches({ ...stored, shadow: { y: 5, x: 0, blur: 12, color: "#000000" } } as never, own)).toBe(false);
  });
});
