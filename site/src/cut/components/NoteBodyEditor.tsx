"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import { Bold, Check, ChevronDown, Italic, Strikethrough, Underline } from "lucide-react";
import { NOTE_TEXT_COLORS, parseNoteBody, serializeNoteBody, type NoteTextColor } from "@/cut/lib/noteMarkdown";
import { blocksOf, docOf, TextColor } from "@/cut/lib/noteDoc";
import { cn } from "@/lib/utils";

/** What a selection can turn its lines into, the way the toolbar names it. */
const TURN_INTO: { id: string; label: string; active: (e: Editor) => boolean; run: (e: Editor) => void }[] = [
  { id: "text", label: "Text", active: (e) => e.isActive("paragraph") && !e.isActive("bulletList") && !e.isActive("orderedList") && !e.isActive("taskList") && !e.isActive("blockquote"), run: (e) => toText(e).setParagraph().run() },
  ...([1, 2, 3] as const).map((level) => ({
    id: `h${level}`,
    label: `Heading ${level}`,
    active: (e: Editor) => e.isActive("heading", { level }),
    run: (e: Editor) => toText(e).setHeading({ level }).run(),
  })),
  { id: "bullet", label: "Bulleted list", active: (e) => e.isActive("bulletList"), run: (e) => toText(e).toggleBulletList().run() },
  { id: "number", label: "Numbered list", active: (e) => e.isActive("orderedList"), run: (e) => toText(e).toggleOrderedList().run() },
  { id: "todo", label: "To-do list", active: (e) => e.isActive("taskList"), run: (e) => toText(e).toggleTaskList().run() },
  { id: "quote", label: "Quote", active: (e) => e.isActive("blockquote"), run: (e) => toText(e).setParagraph().toggleBlockquote().run() },
];
/** Lift the selected lines out of any list or quote first, so every turn
 * starts from plain lines. */
function toText(e: Editor) {
  let chain = e.chain().focus();
  if (e.isActive("bulletList")) chain = chain.toggleBulletList();
  else if (e.isActive("orderedList")) chain = chain.toggleOrderedList();
  else if (e.isActive("taskList")) chain = chain.toggleTaskList();
  if (e.isActive("blockquote")) chain = chain.lift("blockquote");
  return chain;
}

/** The note's body: rich text on the paper, written out as the note's
 * Markdown on every change. Selecting words brings up the toolbar — turn the
 * lines into a heading or a list, bold, italic, underline, strikethrough and
 * color — and the Markdown shortcuts work as they are typed. */
export default function NoteBodyEditor({
  body,
  ink,
  onChange,
  onEditor,
}: {
  /** The body the editor opens on. Later changes to it are ignored: the
   * editor is the source of the body while it is open. */
  body: string;
  ink: string;
  onChange: (body: string) => void;
  onEditor?: (editor: Editor | null) => void;
}) {
  const [initial] = useState(() => docOf(parseNoteBody(body)));
  // The handlers as of the last render; the editor holds the ones it was
  // made with.
  const handlers = useRef({ onChange, onEditor });
  useEffect(() => {
    handlers.current = { onChange, onEditor };
  });
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        code: false,
        codeBlock: false,
        horizontalRule: false,
        link: false,
        hardBreak: false,
        trailingNode: false,
        heading: { levels: [1, 2, 3] },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TextColor,
      Placeholder.configure({ placeholder: "Write your note…" }),
    ],
    content: initial,
    editorProps: { attributes: { class: "outline-none min-h-[50vh]" } },
    onCreate: ({ editor }) => handlers.current.onEditor?.(editor),
    onDestroy: () => handlers.current.onEditor?.(null),
    onUpdate: ({ editor }) => handlers.current.onChange(serializeNoteBody(blocksOf(editor.getJSON()))),
  });

  return (
    <div
      className={cn(
        "text-lg leading-8",
        "[&_h1]:mt-4 [&_h1]:text-3xl [&_h1]:leading-tight [&_h1]:font-semibold",
        "[&_h2]:mt-3 [&_h2]:text-2xl [&_h2]:leading-tight [&_h2]:font-semibold",
        "[&_h3]:mt-2 [&_h3]:text-xl [&_h3]:font-semibold",
        "[&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_ul_ul]:list-[circle] [&_ul_ul_ul]:list-[square]",
        "[&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-0.5",
        "[&_li[data-checked]]:flex [&_li[data-checked]]:gap-2.5 [&_li[data-checked]>label]:mt-0.5 [&_li[data-checked]>div]:flex-1",
        "[&_li[data-checked=true]>div]:line-through [&_li[data-checked=true]>div]:opacity-50",
        "[&_input[type=checkbox]]:size-4 [&_input[type=checkbox]]:cursor-pointer [&_input[type=checkbox]]:accent-current",
        "[&_blockquote]:border-l-[3px] [&_blockquote]:border-current [&_blockquote]:pl-4",
        "[&_.is-editor-empty:first-child]:before:pointer-events-none [&_.is-editor-empty:first-child]:before:float-left [&_.is-editor-empty:first-child]:before:h-0 [&_.is-editor-empty:first-child]:before:opacity-40 [&_.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]",
      )}
      style={{ color: ink }}
    >
      {editor && <Toolbar editor={editor} />}
      <EditorContent editor={editor} />
    </div>
  );
}

/** The selection's toolbar. Every press keeps the editor's focus, so the
 * selection it acts on stays put. */
function Toolbar({ editor }: { editor: Editor }) {
  const [panel, setPanel] = useState<"turn" | "color" | null>(null);
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      turn: TURN_INTO.find((t) => t.active(e))?.label ?? "Text",
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      color: (e.getAttributes("textColor").color as NoteTextColor | undefined) ?? null,
    }),
  });
  const keep = (e: React.MouseEvent) => e.preventDefault();
  const color = NOTE_TEXT_COLORS.find((c) => c.id === state.color);

  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: "top-start", offset: 8, onHide: () => setPanel(null) }}
      className="z-[60] flex items-center gap-0.5 rounded-lg border border-black/10 bg-white p-1 text-sm text-neutral-800 shadow-lg"
      onMouseDown={keep}
    >
      <Menu
        open={panel === "turn"}
        onToggle={() => setPanel(panel === "turn" ? null : "turn")}
        trigger={<>{state.turn}<ChevronDown className="size-3.5 opacity-50" /></>}
      >
        {TURN_INTO.map((t) => (
          <MenuItem key={t.id} checked={t.label === state.turn} onPick={() => { t.run(editor); setPanel(null); }}>
            {t.label}
          </MenuItem>
        ))}
      </Menu>
      <Divider />
      <Toggle label="Bold" on={state.bold} onPress={() => editor.chain().focus().toggleBold().run()}><Bold className="size-4" /></Toggle>
      <Toggle label="Italic" on={state.italic} onPress={() => editor.chain().focus().toggleItalic().run()}><Italic className="size-4" /></Toggle>
      <Toggle label="Underline" on={state.underline} onPress={() => editor.chain().focus().toggleUnderline().run()}><Underline className="size-4" /></Toggle>
      <Toggle label="Strikethrough" on={state.strike} onPress={() => editor.chain().focus().toggleStrike().run()}><Strikethrough className="size-4" /></Toggle>
      <Divider />
      <Menu
        open={panel === "color"}
        onToggle={() => setPanel(panel === "color" ? null : "color")}
        label="Text color"
        trigger={<><span className="font-semibold" style={{ color: color?.paper }}>A</span><ChevronDown className="size-3.5 opacity-50" /></>}
      >
        <MenuItem checked={!color} onPick={() => { editor.chain().focus().unsetMark("textColor").run(); setPanel(null); }}>
          <span className="w-4 text-center font-semibold">A</span> Default
        </MenuItem>
        {NOTE_TEXT_COLORS.map((c) => (
          <MenuItem key={c.id} checked={c.id === state.color} onPick={() => { editor.chain().focus().setMark("textColor", { color: c.id }).run(); setPanel(null); }}>
            <span className="w-4 text-center font-semibold" style={{ color: c.paper }}>A</span> {c.name}
          </MenuItem>
        ))}
      </Menu>
    </BubbleMenu>
  );
}

const Divider = () => <div className="mx-0.5 h-5 w-px bg-black/10" />;

function Toggle({ label, on, onPress, children }: { label: string; on: boolean; onPress: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      className={cn("grid size-7 cursor-pointer place-items-center rounded-md hover:bg-black/5", on && "bg-black/10 hover:bg-black/10")}
      onClick={onPress}
    >
      {children}
    </button>
  );
}

function Menu({ open, onToggle, label, trigger, children }: { open: boolean; onToggle: () => void; label?: string; trigger: ReactNode; children: ReactNode }) {
  return (
    <div className="relative">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        className={cn("flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 hover:bg-black/5", open && "bg-black/5")}
        onClick={onToggle}
      >
        {trigger}
      </button>
      {open && (
        <div role="menu" className="absolute top-full left-0 mt-1.5 w-44 rounded-lg border border-black/10 bg-white p-1 shadow-lg">
          {children}
        </div>
      )}
    </div>
  );
}

function MenuItem({ checked, onPick, children }: { checked: boolean; onPick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-black/5"
      onClick={onPick}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
      {checked && <Check className="size-4 shrink-0 opacity-70" />}
    </button>
  );
}
