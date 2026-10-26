import { Fragment } from "react";
import { NOTE_TEXT_COLORS, parseNoteBody, type NoteBlock, type NoteRun } from "@/cut/lib/noteMarkdown";
import { cn } from "@/lib/utils";

/** The opening lines of a note body as they read on the paper: headings,
 * list markers and styled words, for a note's card. Long lines wrap, and the
 * card shows `lines` lines of it. */
export function NoteBodyPreview({ body, lines, className }: { body: string; lines: number; className?: string }) {
  const blocks = parseNoteBody(body).slice(0, lines);
  // Numbered lines count within their run, the way the editor numbers them.
  const numbers: number[] = [];
  return (
    <div className={cn("overflow-hidden break-words", className)} style={{ maxHeight: `${lines}lh` }}>
      {blocks.map((b, i) => {
        if (b.kind === "number") numbers[b.indent] = (numbers[b.indent] ?? 0) + 1;
        numbers.length = b.kind === "number" ? b.indent + 1 : b.kind === "bullet" || b.kind === "todo" ? b.indent : 0;
        const marker =
          b.kind === "bullet" ? "•" : b.kind === "number" ? `${numbers[b.indent]}.` : b.kind === "todo" ? (b.checked ? "☑" : "☐") : null;
        return (
          <div
            key={i}
            className={cn(
              "min-h-[1lh]",
              b.kind === "heading" && "font-semibold",
              b.kind === "quote" && "border-l-2 border-current pl-1.5",
              b.kind === "todo" && b.checked && "line-through opacity-60",
            )}
            style={{ paddingLeft: b.indent ? `${b.indent * 0.75}rem` : undefined }}
          >
            {marker && <span className="mr-1">{marker}</span>}
            <Runs block={b} />
          </div>
        );
      })}
    </div>
  );
}

function Runs({ block }: { block: NoteBlock }) {
  return block.runs.map((r: NoteRun, i) => {
    const color = r.marks.color ? NOTE_TEXT_COLORS.find((c) => c.id === r.marks.color)?.paper : undefined;
    const styled = r.marks.bold || r.marks.italic || r.marks.underline || r.marks.strike || color;
    if (!styled) return <Fragment key={i}>{r.text}</Fragment>;
    return (
      <span
        key={i}
        className={cn(
          r.marks.bold && "font-semibold",
          r.marks.italic && "italic",
          r.marks.underline && r.marks.strike ? "[text-decoration-line:underline_line-through]" : r.marks.underline ? "underline" : r.marks.strike && "line-through",
        )}
        style={color ? { color } : undefined}
      >
        {r.text}
      </span>
    );
  });
}
