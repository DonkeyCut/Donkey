import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import postcss from "postcss";
import { NOTE_COLORS, noteColor } from "@/cut/lib/notes";

const css = postcss.parse(readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8"));

// Saved palette indices keep the paper colors shared with iOS.
test("note palette indices retain the shared iOS colors", () => {
  expect(NOTE_COLORS.map((c) => [c.name, c.background])).toEqual([
    ["Butter", "#faefb6"], ["Blush", "#fbd8d4"], ["Sky", "#d5e8fb"],
    ["Mint", "#d9f3d6"], ["Lilac", "#e6dcf7"],
  ]);
  expect(noteColor(-1)).toBe(NOTE_COLORS[4]);
  expect(noteColor(5)).toBe(NOTE_COLORS[0]);
});

// Notes keep their paper in dark mode: the paper, its tiles and its menus are
// `.light` elements, which carry the light tokens on a dark page.
test("a light element keeps the light tokens", () => {
  const tokens = new Map<string, string>();
  css.walkRules((rule) => {
    if (rule.selectors.includes(".light")) {
      rule.walkDecls((decl) => { tokens.set(decl.prop, decl.value); });
    }
  });
  expect(tokens.get("color-scheme")).toBe("light");
  expect(tokens.get("--foreground")).toBe("oklch(0.145 0 0)");
  expect(tokens.get("--card")).toBe("oklch(1 0 0)");
  expect(tokens.get("--popover")).toBe("oklch(1 0 0)");
});

// Dark utilities skip a light element and everything inside it, for both the
// explicit `.dark` theme and the system preference.
test("dark utilities skip light elements", () => {
  let variant = "";
  css.walkAtRules("custom-variant", (rule) => {
    if (rule.params === "dark") {
      variant = rule.toString();
    }
  });
  expect(variant.match(/:not\(:where\(\.light, \.light \*\)\)/g)?.length).toBe(2);
});
