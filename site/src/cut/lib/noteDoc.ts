import { Mark, mergeAttributes, type JSONContent } from "@tiptap/core";
import {
  NOTE_LIST_KINDS,
  NOTE_TEXT_COLORS,
  type NoteBlock,
  type NoteBlockKind,
  type NoteMarks,
  type NoteRun,
  type NoteTextColor,
} from "@/cut/lib/noteMarkdown";

/** The note body's blocks as the rich editor's document, and back. Lines nest
 * into the editor's lists by their indent; the editor's lists flatten back to
 * one line per item at its depth. */

const LIST_NODE: Record<string, NoteBlockKind> = { bulletList: "bullet", orderedList: "number", taskList: "todo" };
const LIST_TYPE: Record<string, string> = { bullet: "bulletList", number: "orderedList", todo: "taskList" };

function runsOf(node: JSONContent | undefined): NoteRun[] {
  return (node?.content ?? []).flatMap((n) => {
    if (n.type !== "text" || !n.text) return [];
    const marks: NoteMarks = {};
    for (const m of n.marks ?? []) {
      if (m.type === "bold" || m.type === "italic" || m.type === "underline" || m.type === "strike") marks[m.type] = true;
      else if (m.type === "textColor" && m.attrs?.color) marks.color = m.attrs.color as NoteTextColor;
    }
    return [{ text: n.text, marks }];
  });
}

/** The editor's document as the body's blocks: one block per line, lists
 * flattened to their nesting depth. */
export function blocksOf(doc: JSONContent): NoteBlock[] {
  const out: NoteBlock[] = [];
  const walk = (node: JSONContent, indent: number) => {
    const kind = node.type ? LIST_NODE[node.type] : undefined;
    if (kind) {
      for (const item of node.content ?? []) {
        for (const child of item.content ?? []) {
          if (child.type && LIST_NODE[child.type]) walk(child, indent + 1);
          else out.push({ kind, indent, ...(kind === "todo" ? { checked: !!item.attrs?.checked } : {}), runs: runsOf(child) });
        }
      }
    } else if (node.type === "heading") {
      out.push({ kind: "heading", level: node.attrs?.level ?? 1, indent: 0, runs: runsOf(node) });
    } else if (node.type === "blockquote") {
      for (const child of node.content ?? []) {
        if (child.type === "paragraph") out.push({ kind: "quote", indent: 0, runs: runsOf(child) });
        else walk(child, indent);
      }
    } else if (node.type === "paragraph") {
      out.push({ kind: "paragraph", indent: 0, runs: runsOf(node) });
    } else {
      for (const child of node.content ?? []) walk(child, indent);
    }
  };
  walk(doc, 0);
  return out;
}

function inline(runs: NoteRun[]): JSONContent[] {
  return runs
    .filter((r) => r.text)
    .map((r) => {
      const marks = [
        ...(["bold", "italic", "underline", "strike"] as const).filter((m) => r.marks[m]).map((type) => ({ type })),
        ...(r.marks.color ? [{ type: "textColor", attrs: { color: r.marks.color } }] : []),
      ];
      return { type: "text", text: r.text, ...(marks.length ? { marks } : {}) };
    });
}
const paragraph = (runs: NoteRun[]): JSONContent => {
  const content = inline(runs);
  return content.length ? { type: "paragraph", content } : { type: "paragraph" };
};
const listItem = (b: NoteBlock): JSONContent =>
  b.kind === "todo"
    ? { type: "taskItem", attrs: { checked: !!b.checked }, content: [paragraph(b.runs)] }
    : { type: "listItem", content: [paragraph(b.runs)] };

/** A run of list lines from `i`, at `indent` and deeper, as one list node
 * with the deeper lines nested under the item above them. */
function listFrom(blocks: NoteBlock[], i: number, indent: number): [JSONContent, number] {
  const kind = blocks[i].kind;
  const items: JSONContent[] = [];
  while (i < blocks.length) {
    const b = blocks[i];
    if (!NOTE_LIST_KINDS.has(b.kind) || b.indent < indent) break;
    if (b.indent === indent) {
      if (b.kind !== kind) break;
      items.push(listItem(b));
      i++;
    } else {
      const [sub, next] = listFrom(blocks, i, b.indent);
      if (items.length === 0) items.push(listItem({ ...b, runs: [] }));
      items.at(-1)!.content!.push(sub);
      i = next;
    }
  }
  return [{ type: LIST_TYPE[kind], content: items }, i];
}

/** The body's blocks as the editor's document. */
export function docOf(blocks: NoteBlock[]): JSONContent {
  const content: JSONContent[] = [];
  for (let i = 0; i < blocks.length; ) {
    const b = blocks[i];
    if (NOTE_LIST_KINDS.has(b.kind)) {
      const [list, next] = listFrom(blocks, i, b.indent);
      content.push(list);
      i = next;
    } else if (b.kind === "quote") {
      const lines: JSONContent[] = [];
      while (i < blocks.length && blocks[i].kind === "quote") lines.push(paragraph(blocks[i++].runs));
      content.push({ type: "blockquote", content: lines });
    } else {
      content.push(b.kind === "heading" ? { type: "heading", attrs: { level: b.level ?? 1 }, content: inline(b.runs) } : paragraph(b.runs));
      i++;
    }
  }
  return { type: "doc", content };
}

/** A named text color. The name is what the body stores; the ink is the
 * paper's. */
export const TextColor = Mark.create({
  name: "textColor",
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-color"),
        renderHTML: (attrs) => ({
          "data-color": attrs.color,
          style: `color: ${NOTE_TEXT_COLORS.find((c) => c.id === attrs.color)?.paper ?? "inherit"}`,
        }),
      },
    };
  },
  parseHTML: () => [{ tag: "span[data-color]" }],
  renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes), 0],
});
