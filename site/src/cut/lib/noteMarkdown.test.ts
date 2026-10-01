import { describe, expect, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import { Node } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { noteBodyText, parseInline, parseNoteBody, serializeNoteBody } from "@/cut/lib/noteMarkdown";
import { blocksOf, docOf, TextColor } from "@/cut/lib/noteDoc";

const roundTrip = (body: string) => serializeNoteBody(parseNoteBody(body));

describe("note markdown", () => {
  test("a plain-text note reads one paragraph per line", () => {
    const body = "Template\nfind a template to replicate\n\nCut Demo";
    expect(parseNoteBody(body).map((b) => b.kind)).toEqual(["paragraph", "paragraph", "paragraph", "paragraph"]);
    expect(roundTrip(body)).toBe(body);
  });

  test("block markers, nesting and to-dos round-trip", () => {
    const body = [
      "# Title",
      "## Section",
      "### Sub",
      "- one",
      "  - nested",
      "    - deeper",
      "1. first",
      "2. second",
      "  - aside",
      "3. third",
      "- [ ] open",
      "- [x] done",
      "> quoted",
      "",
      "plain",
    ].join("\n");
    expect(roundTrip(body)).toBe(body);
    const blocks = parseNoteBody(body);
    expect(blocks[4]).toMatchObject({ kind: "bullet", indent: 1 });
    expect(blocks[11]).toMatchObject({ kind: "todo", checked: true });
  });

  test("numbered runs renumber and other bullets read as bullets", () => {
    expect(roundTrip("5. a\n9. b\ntext\n3. c")).toBe("1. a\n2. b\ntext\n1. c");
    expect(roundTrip("* a\n• b")).toBe("- a\n- b");
  });

  test("inline marks parse and nest across seams", () => {
    expect(parseInline("**bold *both* bold** <u>under</u> ~~gone~~ <span color=\"red\">red</span>")).toEqual([
      { text: "bold ", marks: { bold: true } },
      { text: "both", marks: { bold: true, italic: true } },
      { text: " bold", marks: { bold: true } },
      { text: " ", marks: {} },
      { text: "under", marks: { underline: true } },
      { text: " ", marks: {} },
      { text: "gone", marks: { strike: true } },
      { text: " ", marks: {} },
      { text: "red", marks: { color: "red" } },
    ]);
    for (const body of ["**bold *both* bold**", "<span color=\"blue\"><u>**a**</u></span>b", "*a***b**"]) {
      expect(serializeNoteBody(parseNoteBody(roundTrip(body)))).toBe(roundTrip(body));
      expect(parseNoteBody(roundTrip(body))).toEqual(parseNoteBody(body));
    }
  });

  test("stray delimiters and unknown tags stay literal", () => {
    expect(noteBodyText("5 * 3 = 15")).toBe("5 * 3 = 15");
    expect(noteBodyText("a <b>tag</b> and <span color=\"teal\">x</span>")).toBe("a <b>tag</b> and <span color=\"teal\">x</span>");
    expect(noteBodyText("close </u> first")).toBe("close </u> first");
  });

  test("literal text that looks like markup is escaped and reads back", () => {
    const blocks = [
      { kind: "paragraph" as const, indent: 0, runs: [{ text: "- not a bullet *or* <u>tag</u> \\ ~~", marks: {} }] },
      { kind: "paragraph" as const, indent: 0, runs: [{ text: "1. not a number", marks: {} }] },
      { kind: "paragraph" as const, indent: 0, runs: [{ text: "# not a heading", marks: {} }] },
    ];
    expect(parseNoteBody(serializeNoteBody(blocks))).toEqual(blocks);
  });
});

describe("note editor document", () => {
  const schema = getSchema([StarterKit, TaskList, TaskItem.configure({ nested: true }), TextColor]);
  test("bodies survive the trip through the editor's document", () => {
    for (const body of [
      "",
      "plain\n\nlines",
      "# Title\n- a\n  - b\n    1. c\n    2. d\n- e\n- [ ] f\n  - [x] g\n> q1\n> q2\ntext",
      "**bold** *it* <u>u</u> ~~s~~ <span color=\"green\">**g**</span>",
    ]) {
      const doc = docOf(parseNoteBody(body));
      // The document has to be valid for the editor's schema.
      expect(() => Node.fromJSON(schema, doc).check()).not.toThrow();
      expect(serializeNoteBody(blocksOf(doc))).toBe(body);
    }
  });
});
