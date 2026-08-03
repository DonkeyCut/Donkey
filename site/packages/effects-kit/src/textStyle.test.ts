import { describe, expect, test } from "bun:test";
import { pickTextStyle, TEXT_STYLE_FIELDS, type TextOverlay } from "./types";

const title = (over: Partial<TextOverlay> = {}): TextOverlay => ({
  id: "t1",
  kind: "text",
  text: "Hello",
  start: 1,
  end: 4,
  x: 0.25,
  y: 0.75,
  size: 88,
  font: "anton",
  weight: 700,
  color: "#fff",
  shadow: true,
  plate: false,
  rotation: 20,
  opacity: 0.5,
  ...over,
});

describe("text style", () => {
  test("carries every style field and nothing that identifies the title", () => {
    const style = pickTextStyle(title({ italic: true, letterSpacing: 0.1 }));
    expect(Object.keys(style).sort()).toEqual([...TEXT_STYLE_FIELDS].sort());
    // What makes it that particular title stays behind.
    for (const own of ["id", "text", "start", "end", "x", "y", "rotation", "opacity"]) {
      expect(own in style).toBe(false);
    }
    expect(style.size).toBe(88);
    expect(style.font).toBe("anton");
    expect(style.italic).toBe(true);
    expect(style.letterSpacing).toBe(0.1);
  });

  test("applying a style over a title changes its look and leaves it in place", () => {
    const original = title();
    const styled = { ...original, ...pickTextStyle(title({ size: 40, color: "#0f0" })) };
    expect(styled.size).toBe(40);
    expect(styled.color).toBe("#0f0");
    expect(styled.x).toBeCloseTo(0.25); // still where it was
    expect(styled.text).toBe("Hello");
  });

  test("an unset field is carried as unset, so a saved look does not invent one", () => {
    const style = pickTextStyle(title());
    expect("italic" in style).toBe(true);
    expect(style.italic).toBe(undefined);
    expect(JSON.parse(JSON.stringify(style)).italic).toBe(undefined);
  });
});
