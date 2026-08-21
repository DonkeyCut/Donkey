"use client";

import { useEffect, useRef } from "react";
import { ArrowLeft, Check, ChevronDown, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NOTE_COLORS, noteColor } from "@/cut/lib/notes";

// The note paper's ink, matching the iOS app.
const NOTE_INK = "#201a0d";

export interface NoteDraft {
  id: string;
  title: string;
  body: string;
  colorIndex: number;
  folderId: string | null;
  isNew: boolean;
  /** What the note held when it opened. A draft that still matches closes
   * without a write, so opening a note to read it leaves the list alone. */
  saved: { title: string; body: string; colorIndex: number };
}

/** True when the draft holds something the stored note does not. */
export const noteChanged = (d: NoteDraft) =>
  d.title.trim() !== d.saved.title ||
  d.body.trim() !== d.saved.body ||
  d.colorIndex !== d.saved.colorIndex;

/** A text box that grows with what is written, so the page scrolls as one
 * sheet of paper. */
function useAutoGrow(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return ref;
}

/** The note itself, filling the window: a page of paper with a title, a body
 * that runs as long as it needs to, and the paper's color on a menu. Closing
 * it — the back arrow, Done, or Escape — hands the draft back to be saved. */
export function NoteComposer({
  draft,
  onChange,
  onClose,
  onDelete,
}: {
  draft: NoteDraft;
  onChange: (draft: NoteDraft) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const paper = noteColor(draft.colorIndex);
  const titleRef = useAutoGrow(draft.title);
  const bodyRef = useAutoGrow(draft.body);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key === "Enter")) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="flex min-h-full flex-col"
      style={{ backgroundColor: paper.background, color: NOTE_INK }}
    >
      <header
        className="sticky top-0 z-10 flex items-center gap-2 px-6 py-3"
        style={{ backgroundColor: paper.background }}
      >
        <Button
          variant="ghost"
          className="hover:bg-black/5 hover:text-current"
          style={{ color: NOTE_INK }}
          onClick={onClose}
        >
          <ArrowLeft data-icon="inline-start" /> All notes
        </Button>
        <div className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                aria-label="Note color"
                className="hover:bg-black/5 hover:text-current"
                style={{ color: NOTE_INK }}
              />
            }
          >
            <span
              className="size-3.5 rounded-full border border-black/10"
              style={{ backgroundColor: paper.accent }}
            />
            {paper.name}
            <ChevronDown className="size-3.5 opacity-60" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            {NOTE_COLORS.map((c, i) => (
              <DropdownMenuItem
                key={c.name}
                className="gap-2"
                onClick={() => onChange({ ...draft, colorIndex: i })}
              >
                <span
                  className="size-3.5 rounded-full border border-black/10"
                  style={{ backgroundColor: c.accent }}
                />
                <span className="flex-1">{c.name}</span>
                {i === draft.colorIndex && <Check className="size-4 opacity-70" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {!draft.isNew && (
          <Button
            variant="ghost"
            aria-label="Delete note"
            className="text-destructive hover:bg-black/5 hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 data-icon="inline-start" /> Delete
          </Button>
        )}
        <Button className="bg-black/80 text-white hover:bg-black" onClick={onClose}>
          Done
        </Button>
      </header>

      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-8 pt-6 pb-32">
        <textarea
          ref={titleRef}
          autoFocus
          rows={1}
          value={draft.title}
          placeholder="Untitled"
          className="resize-none overflow-hidden bg-transparent text-4xl leading-tight font-semibold tracking-tight outline-none placeholder:opacity-30"
          style={{ color: NOTE_INK }}
          onChange={(e) => onChange({ ...draft, title: e.target.value.replace(/\n/g, "") })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              bodyRef.current?.focus();
            }
          }}
        />
        <textarea
          ref={bodyRef}
          rows={1}
          value={draft.body}
          placeholder="Write your note…"
          className="min-h-[50vh] flex-1 resize-none overflow-hidden bg-transparent text-lg leading-8 outline-none placeholder:opacity-40"
          style={{ color: NOTE_INK }}
          onChange={(e) => onChange({ ...draft, body: e.target.value })}
        />
      </div>
    </div>
  );
}
