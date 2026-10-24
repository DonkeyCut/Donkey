import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import postcss from "postcss";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { DOMSerializer } from "@tiptap/pm/model";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { NOTE_COLORS, noteColor } from "@/cut/lib/notes";
import { NOTE_TEXT_COLORS, parseNoteBody } from "@/cut/lib/noteMarkdown";
import { docOf, TextColor } from "@/cut/lib/noteDoc";
import { NoteBodyPreview } from "./NoteBodyPreview";

// Saved palette indices keep their paper colors while CSS adapts the surface.
test("note palette indices retain the shared iOS colors", () => {
  expect(NOTE_COLORS.map((c) => [c.name, c.background])).toEqual([
    ["Butter", "#faefb6"], ["Blush", "#fbd8d4"], ["Sky", "#d5e8fb"],
    ["Mint", "#d9f3d6"], ["Lilac", "#e6dcf7"],
  ]);
  expect(noteColor(-1)).toBe(NOTE_COLORS[4]);
  expect(noteColor(5)).toBe(NOTE_COLORS[0]);
});

test("dark note paper pairs a muted card tint with its foreground", () => {
  const css = postcss.parse(readFileSync(new URL("./notePaper.css", import.meta.url), "utf8"));
  const dark = new Map<string, string>();
  css.walkAtRules("variant", (rule) => {
    if (rule.params === "dark") {
      rule.walkDecls((decl) => { dark.set(decl.prop, decl.value); });
    }
  });
  expect(dark.get("background-color")).toBe("color-mix(in srgb, var(--card) 94%, var(--note-accent) 6%)");
  expect(dark.get("color")).toBe("var(--card-foreground)");
  expect(dark.get("--note-text-ink")).toBe("color-mix(in srgb, var(--note-text-dark) 75%, white 25%)");
});

test("editor and tile text colors retain named marks and theme palettes", () => {
  const schema = getSchema([StarterKit.configure({ link: false }), TextColor]);
  const serializer = DOMSerializer.fromSchema(schema);
  for (const color of NOTE_TEXT_COLORS) {
    const body = `<span color="${color.id}">Readable color</span>`;
    const { document } = parseHTML("<html><body></body></html>");
    const node = schema.nodeFromJSON(docOf(parseNoteBody(body)));
    const container = document.createElement("div");
    container.appendChild(serializer.serializeFragment(node.content, { document }));
    const preview = parseHTML(renderToStaticMarkup(<NoteBodyPreview body={body} lines={2} />)).document;
    for (const span of [container.querySelector("[data-color]"), preview.querySelector("[data-color]")]) {
      expect(span?.getAttribute("data-color")).toBe(color.id);
      expect(span?.getAttribute("style")).toContain("var(--note-text-ink,");
      expect(span?.getAttribute("style")).toContain(color.paper);
      expect(span?.getAttribute("style")).toContain(color.dark);
    }
  }
});
