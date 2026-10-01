/** The note body's format: a line-per-block Markdown that the web editor, the
 * phone's editor, its teleprompter and the chat all read and write.
 *
 * Every line is one block, so a note written as plain text — one thought to a
 * line — reads exactly as it was typed. A line opens with its block's marker:
 *
 *   # Heading         ## Smaller          ### Smallest
 *   - Bullet          1. Numbered         - [ ] To-do      - [x] Done
 *   > Quote
 *
 * List lines nest two spaces per level. Inside a line, **bold**, *italic*,
 * ~~strikethrough~~, <u>underline</u> and <span color="red">color</span> style
 * the words, and a backslash keeps the next character literal. The phone's
 * parser in DonkeyKit follows this file; a change here changes both. */

/** Text colors, by name, with the ink each one takes on the note's paper and
 * on the dark teleprompter. */
export const NOTE_TEXT_COLORS = [
  { id: "gray", name: "Gray", paper: "#787774", dark: "#9b9b9b" },
  { id: "brown", name: "Brown", paper: "#9f6b53", dark: "#ba856f" },
  { id: "orange", name: "Orange", paper: "#d9730d", dark: "#c77d48" },
  { id: "yellow", name: "Yellow", paper: "#cb912f", dark: "#ca9849" },
  { id: "green", name: "Green", paper: "#448361", dark: "#529e72" },
  { id: "blue", name: "Blue", paper: "#337ea9", dark: "#5e87c9" },
  { id: "purple", name: "Purple", paper: "#9065b0", dark: "#9d68d3" },
  { id: "pink", name: "Pink", paper: "#c14c8a", dark: "#d15796" },
  { id: "red", name: "Red", paper: "#d44c47", dark: "#df5452" },
] as const;
export type NoteTextColor = (typeof NOTE_TEXT_COLORS)[number]["id"];
const COLOR_IDS = new Set<string>(NOTE_TEXT_COLORS.map((c) => c.id));

export type NoteBlockKind = "paragraph" | "heading" | "bullet" | "number" | "todo" | "quote";
export const NOTE_LIST_KINDS = new Set<NoteBlockKind>(["bullet", "number", "todo"]);
/** How deep a list nests. */
export const NOTE_INDENT_MAX = 5;

export type NoteMarks = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: NoteTextColor;
};
export type NoteRun = { text: string; marks: NoteMarks };
export type NoteBlock = {
  kind: NoteBlockKind;
  /** Heading size, 1 to 3. */
  level?: number;
  /** List nesting, 0 at the margin. */
  indent: number;
  checked?: boolean;
  runs: NoteRun[];
};

/** What the chat is taught about writing a note body, from the same lists. */
export const NOTE_BODY_FORMAT =
  "The body is one block per line: '# ', '## ', '### ' headings; '- ' bullets; '1. ' numbered items; '- [ ] ' and '- [x] ' to-dos; '> ' quotes; any other line is a paragraph. " +
  "List lines nest two spaces per level. Inline: **bold**, *italic*, ~~strikethrough~~, <u>underline</u>, <span color=\"NAME\">colored text</span> with NAME one of " +
  NOTE_TEXT_COLORS.map((c) => c.id).join(", ") +
  ". A backslash keeps the next character literal.";

const LIST_LINE = /^((?: {2})*)(?:([-*•]) \[( |x|X)\] |([-*•]) |(\d+)\. )/;
const HEADING_LINE = /^(#{1,3}) /;

/** Read a body into its blocks. */
export function parseNoteBody(body: string): NoteBlock[] {
  return body.split("\n").map(parseLine);
}

function parseLine(line: string): NoteBlock {
  const list = LIST_LINE.exec(line);
  if (list) {
    const indent = Math.min(list[1].length / 2, NOTE_INDENT_MAX);
    const rest = line.slice(list[0].length);
    if (list[3] !== undefined) return { kind: "todo", indent, checked: list[3] !== " ", runs: parseInline(rest) };
    if (list[4] !== undefined) return { kind: "bullet", indent, runs: parseInline(rest) };
    return { kind: "number", indent, runs: parseInline(rest) };
  }
  const heading = HEADING_LINE.exec(line);
  if (heading) return { kind: "heading", level: heading[1].length, indent: 0, runs: parseInline(line.slice(heading[0].length)) };
  if (line.startsWith("> ")) return { kind: "quote", indent: 0, runs: parseInline(line.slice(2)) };
  return { kind: "paragraph", indent: 0, runs: parseInline(line) };
}

type Token =
  | { t: "text"; v: string }
  | { t: "toggle"; mark: "bold" | "italic" | "strike"; v: string }
  | { t: "open"; mark: "underline" | "color"; color?: NoteTextColor; v: string }
  | { t: "close"; mark: "underline" | "color"; v: string };

const TAG = /^<(u|\/u|\/span|span color="([a-z]+)")>/;

function tokenize(s: string): Token[] {
  const out: Token[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) {
      text += s[i + 1];
      i += 2;
    } else if (s.startsWith("**", i)) {
      flush();
      out.push({ t: "toggle", mark: "bold", v: "**" });
      i += 2;
    } else if (c === "*") {
      flush();
      out.push({ t: "toggle", mark: "italic", v: "*" });
      i += 1;
    } else if (s.startsWith("~~", i)) {
      flush();
      out.push({ t: "toggle", mark: "strike", v: "~~" });
      i += 2;
    } else if (c === "<" && TAG.test(s.slice(i))) {
      const m = TAG.exec(s.slice(i))!;
      const tag = m[1];
      if (tag.startsWith("span") && !COLOR_IDS.has(m[2])) {
        text += m[0];
      } else {
        flush();
        if (tag === "u") out.push({ t: "open", mark: "underline", v: m[0] });
        else if (tag === "/u") out.push({ t: "close", mark: "underline", v: m[0] });
        else if (tag === "/span") out.push({ t: "close", mark: "color", v: m[0] });
        else out.push({ t: "open", mark: "color", color: m[2] as NoteTextColor, v: m[0] });
      }
      i += m[0].length;
    } else {
      text += c;
      i += 1;
    }
  }
  flush();
  return out;
}

/** A line's styled runs. A delimiter with nothing to pair with — the lone
 * star in "5 * 3" — is read as the text it is. */
export function parseInline(s: string): NoteRun[] {
  const tokens = tokenize(s);
  // Toggles pair up in order; an odd one out is literal.
  for (const mark of ["bold", "italic", "strike"] as const) {
    const at = tokens.flatMap((tk, i) => (tk.t === "toggle" && tk.mark === mark ? [i] : []));
    if (at.length % 2) tokens[at.at(-1)!] = { t: "text", v: tokens[at.at(-1)!].v };
  }
  // Tags pair open-to-close; a close with nothing open, or an open never
  // closed, is literal.
  for (const mark of ["underline", "color"] as const) {
    const open: number[] = [];
    tokens.forEach((tk, i) => {
      if (tk.t === "open" && tk.mark === mark) open.push(i);
      else if (tk.t === "close" && tk.mark === mark) {
        if (open.length) open.pop();
        else tokens[i] = { t: "text", v: tk.v };
      }
    });
    for (const i of open) tokens[i] = { t: "text", v: tokens[i].v };
  }
  const runs: NoteRun[] = [];
  const marks: NoteMarks = {};
  const colors: NoteTextColor[] = [];
  let underline = 0;
  for (const tk of tokens) {
    if (tk.t === "text") {
      const now: NoteMarks = { ...marks };
      if (underline > 0) now.underline = true;
      if (colors.length) now.color = colors.at(-1);
      const last = runs.at(-1);
      if (last && sameMarks(last.marks, now)) last.text += tk.v;
      else runs.push({ text: tk.v, marks: now });
    } else if (tk.t === "toggle") {
      if (marks[tk.mark]) delete marks[tk.mark];
      else marks[tk.mark] = true;
    } else if (tk.t === "open") {
      if (tk.mark === "underline") underline++;
      else colors.push(tk.color!);
    } else if (tk.mark === "underline") underline--;
    else colors.pop();
  }
  return runs;
}

const sameMarks = (a: NoteMarks, b: NoteMarks) =>
  !!a.bold === !!b.bold &&
  !!a.italic === !!b.italic &&
  !!a.underline === !!b.underline &&
  !!a.strike === !!b.strike &&
  a.color === b.color;

/** Write blocks back out as a body. Numbered items count up within their run
 * at each level. */
export function serializeNoteBody(blocks: NoteBlock[]): string {
  const counts: number[] = [];
  return blocks
    .map((b) => {
      const indent = NOTE_LIST_KINDS.has(b.kind) ? Math.min(Math.max(b.indent, 0), NOTE_INDENT_MAX) : 0;
      // A numbered run restarts after anything that is not a deeper list line.
      if (b.kind === "number") {
        counts.length = indent + 1;
        counts[indent] = (counts[indent] ?? 0) + 1;
      } else {
        counts.length = NOTE_LIST_KINDS.has(b.kind) ? indent + 1 : 0;
        if (NOTE_LIST_KINDS.has(b.kind)) counts[indent] = 0;
      }
      const pad = "  ".repeat(indent);
      const text = serializeInline(b.runs);
      switch (b.kind) {
        case "heading":
          return `${"#".repeat(Math.min(Math.max(b.level ?? 1, 1), 3))} ${text}`;
        case "bullet":
          return `${pad}- ${text}`;
        case "number":
          return `${pad}${counts[indent]}. ${text}`;
        case "todo":
          return `${pad}- [${b.checked ? "x" : " "}] ${text}`;
        case "quote":
          return `> ${text}`;
        default:
          // A paragraph that starts like a marker keeps its first character
          // literal, so it reads back as the paragraph it is.
          return LIST_LINE.test(text) || HEADING_LINE.test(text) || text.startsWith("> ")
            ? `\\${text}`
            : text;
      }
    })
    .join("\n");
}

const escapeText = (s: string) => s.replace(/[\\*~<]/g, (c) => `\\${c}`);

// Marks open outside-in in this order and close inside-out, so a run that
// shares a mark with the one before it keeps it open across the seam.
const ORDER = ["color", "underline", "strike", "bold", "italic"] as const;
type Open = { mark: (typeof ORDER)[number]; color?: NoteTextColor };
const openTag = (o: Open) =>
  o.mark === "color" ? `<span color="${o.color}">` : o.mark === "underline" ? "<u>" : o.mark === "strike" ? "~~" : o.mark === "bold" ? "**" : "*";
const closeTag = (o: Open) =>
  o.mark === "color" ? "</span>" : o.mark === "underline" ? "</u>" : openTag(o);

export function serializeInline(runs: NoteRun[]): string {
  let out = "";
  const stack: Open[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const want = ORDER.flatMap((mark): Open[] =>
      mark === "color" ? (run.marks.color ? [{ mark, color: run.marks.color }] : []) : run.marks[mark] ? [{ mark }] : [],
    );
    // Keep the longest prefix of what is open that the run still wears.
    let keep = 0;
    while (keep < stack.length && keep < want.length && stack[keep].mark === want[keep].mark && stack[keep].color === want[keep].color) keep++;
    while (stack.length > keep) out += closeTag(stack.pop()!);
    for (const o of want.slice(keep)) {
      out += openTag(o);
      stack.push(o);
    }
    out += escapeText(run.text);
  }
  while (stack.length) out += closeTag(stack.pop()!);
  return out;
}

/** The words of a body with its markup taken out. */
export function noteBodyText(body: string): string {
  return parseNoteBody(body)
    .map((b) => b.runs.map((r) => r.text).join(""))
    .join("\n");
}
