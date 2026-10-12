import { describe, expect, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import { Node } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { noteBodyText, parseInline, parseNoteBody, pastedNoteBlocks, serializeNoteBody } from "@/cut/lib/noteMarkdown";
import { blocksOf, docOf, dropBlankLines, splitSelection, TextColor } from "@/cut/lib/noteDoc";

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

  test("pasted Markdown lists come in as lists, loose lists closed up", () => {
    const pasted = (text: string) => {
      const blocks = pastedNoteBlocks(text);
      return blocks && serializeNoteBody(blocks);
    };
    expect(pasted("1. one\r\n\r\n2. two\n\n\n3. three\n")).toBe("1. one\n2. two\n3. three");
    expect(pasted("Plan\n\n- a\n\n- b\n\nAfter")).toBe("Plan\n\n- a\n- b\n\nAfter");
    expect(pasted("just words\n\nmore words")).toBeNull();
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

  test("blank lines inside a selection drop before it turns into a list", () => {
    const body = "one\n\ntwo\n\nthree\n\nafter";
    const doc = Node.fromJSON(schema, docOf(parseNoteBody(body)));
    const lines = (from: number, to: number) => {
      const state = EditorState.create({ doc, selection: TextSelection.create(doc, from, to) });
      const tr = state.tr;
      dropBlankLines({ tr } as Parameters<typeof dropBlankLines>[0]);
      return serializeNoteBody(blocksOf(tr.doc.toJSON()));
    };
    // From inside "one" to inside "three": the blanks between go, the one after stays.
    expect(lines(2, 16)).toBe("one\ntwo\nthree\n\nafter");
    // A blank line on its own is left for the list to take.
    expect(lines(6, 6)).toBe(body);
  });

  test("selected words cut out onto their own lines before a list takes them", () => {
    const cut = (body: string, words: string) => {
      const doc = Node.fromJSON(schema, docOf(parseNoteBody(body)));
      // The words' positions: one past the line's opening.
      const from = doc.textContent.indexOf(words) + 1;
      const state = EditorState.create({ doc, selection: TextSelection.create(doc, from, from + words.length) });
      const tr = state.tr;
      splitSelection({ tr } as Parameters<typeof splitSelection>[0]);
      return [serializeNoteBody(blocksOf(tr.doc.toJSON())), tr.doc.textBetween(tr.selection.from, tr.selection.to, "|")];
    };
    expect(cut("milk eggs bread", "eggs")).toEqual(["milk\neggs\nbread", "eggs"]);
    expect(cut("I quit. I'll find one.", "I'll find one.")).toEqual(["I quit.\nI'll find one.", "I'll find one."]);
    expect(cut("I quit. I'll find one.", " I'll")).toEqual(["I quit.\nI'll\nfind one.", "I'll"]);
    // A whole line, or a piece of a heading, stays as it is.
    expect(cut("milk eggs", "milk eggs")).toEqual(["milk eggs", "milk eggs"]);
    expect(cut("# milk eggs", "eggs")).toEqual(["# milk eggs", "eggs"]);
  });
});
