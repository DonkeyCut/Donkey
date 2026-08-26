"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Check, ChevronDown, Pencil, Plus, Tag, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { NOTE_COLORS, noteColor, type CutNoteLabel } from "@/cut/lib/notes";
import { NOTE_LABELS_MAX } from "@/cut/lib/types";
import { cn } from "@/lib/utils";

// The note paper's ink, matching the iOS app.
const NOTE_INK = "#201a0d";

export interface NoteDraft {
  id: string;
  title: string;
  body: string;
  colorIndex: number;
  folderId: string | null;
  labelIds: string[];
  isNew: boolean;
  /** What the note held when it opened. A draft that still matches closes
   * without a write, so opening a note to read it leaves the list alone. */
  saved: { title: string; body: string; colorIndex: number; labelIds: string[] };
}

/** The labels a note wears, as a comparable key. A note wears a set — the
 * chips read in the account's own order, and the picker appends where it
 * toggles — so taking a label off and putting it back is no change, and must
 * not stamp the note as edited: that stamp wins last-writer-wins against a
 * real edit made on the phone. */
const labelKey = (ids: string[]) => [...new Set(ids)].sort().join("\n");

/** True when the draft holds something the stored note does not. */
export const noteChanged = (d: NoteDraft) =>
  d.title.trim() !== d.saved.title ||
  d.body.trim() !== d.saved.body ||
  d.colorIndex !== d.saved.colorIndex ||
  labelKey(d.labelIds) !== labelKey(d.saved.labelIds);

/** The box that scrolls around `node`: the app shell gives each page a main
 * column with its own scrollbar, and the document itself scrolls only where
 * nothing else claims it. */
function scrollBoxOf(node: HTMLElement | null): HTMLElement {
  for (let el = node?.parentElement ?? null; el; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY;
    if (overflow === "auto" || overflow === "scroll") return el;
  }
  return document.documentElement;
}

/** A text box that grows with what is written, so the page scrolls as one
 * sheet of paper. Measuring the text means collapsing the box first, which
 * drops the sheet's height for an instant and makes the browser clamp how far
 * it is scrolled. The place in the note is taken before the measure and handed
 * back after it, ahead of the frame being painted, so a backspace partway down
 * a long note leaves the words where they are. */
function useAutoGrow(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = scrollBoxOf(el);
    const at = box.scrollTop;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    if (box.scrollTop !== at) box.scrollTop = at;
  }, [value]);
  return ref;
}

/** The note itself, over the whole window: a sheet of paper with a title, a
 * body that runs as long as it needs to, and the paper's color on a menu. It
 * covers the app — sidebar and all — so writing a note is the only thing on
 * screen, and the page behind it holds still while it is open. Closing it —
 * the back arrow, Done, or Escape — hands the draft back to be saved. */
export function NoteComposer({
  draft,
  back,
  from,
  labels,
  onChange,
  onClose,
  onDelete,
  onCreateLabel,
  onRenameLabel,
  onDeleteLabel,
}: {
  draft: NoteDraft;
  /** Where closing goes back to: the folder the note is filed in, or all
   * notes when it sits at the top level. */
  back: string;
  /** The list this note was opened from. The sheet is portaled out of the
   * page, so this is how it finds the box to hold still while it is up. */
  from?: React.RefObject<HTMLElement | null>;
  /** Every label on the account, for the note's label row and its picker. */
  labels: CutNoteLabel[];
  onChange: (draft: NoteDraft) => void;
  onClose: () => void;
  onDelete: () => void;
  /** Make a label and answer with its id, so the picker can put it on the
   * note at once. */
  onCreateLabel: (name: string) => string;
  onRenameLabel: (id: string, name: string) => void;
  onDeleteLabel: (id: string) => void;
}) {
  const paper = noteColor(draft.colorIndex);
  const titleRef = useAutoGrow(draft.title);
  const bodyRef = useAutoGrow(draft.body);
  // While the label picker is up, Escape is its to close.
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && picking) return;
      if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key === "Enter")) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, picking]);

  const toggleLabel = (id: string) => {
    const worn = draft.labelIds.includes(id);
    // A full note takes no more: the server refuses the write past the cap,
    // so the picker is where it stops.
    if (!worn && draft.labelIds.length >= NOTE_LABELS_MAX) return;
    onChange({
      ...draft,
      labelIds: worn ? draft.labelIds.filter((l) => l !== id) : [...draft.labelIds, id],
    });
  };
  // The note's labels, in the order the account lists them. An id naming
  // nothing — a label deleted on another device — drops out of view.
  const worn = labels.filter((l) => draft.labelIds.includes(l.id));

  // The page behind the sheet stays put, so a wheel over the note moves the
  // note and closing it comes back to the same place in the list. The app shell
  // scrolls its own main column, so the lock goes on whichever box actually
  // scrolls around the list this note was opened from.
  useEffect(() => {
    const box = scrollBoxOf(from?.current ?? null);
    const held = box.style.overflow;
    box.style.overflow = "hidden";
    return () => {
      box.style.overflow = held;
    };
  }, [from]);

  // Portaled to the body so the sheet covers the app: a press on the paper is
  // a press on the note, and it never reaches the list's rubber-band selection
  // underneath.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={draft.title.trim() || "Untitled note"}
      className="fixed inset-0 z-50 flex flex-col font-system antialiased"
      style={{ backgroundColor: paper.background, color: NOTE_INK }}
    >
      <header
        className="flex shrink-0 items-center gap-2 px-6 py-3"
        style={{ backgroundColor: paper.background }}
      >
        <Button
          variant="ghost"
          className="hover:bg-black/5 hover:text-current"
          style={{ color: NOTE_INK }}
          onClick={onClose}
        >
          <ArrowLeft data-icon="inline-start" />{" "}
          <span className="max-w-56 truncate">{back}</span>
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

      {/* The paper scrolls, the header does not. Both text boxes grow with what
          is written and never scroll on their own, so a wheel anywhere over
          the sheet moves the sheet. */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-8 pt-6 pb-32">
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
        {/* The note's labels, worn under the title. The picker adds and
            removes them, and keeps the account's label list itself. */}
        <div className="flex flex-wrap items-center gap-1.5">
          {worn.map((l) => (
            <button
              key={l.id}
              className="group flex cursor-pointer items-center gap-1 rounded-full bg-black/10 px-2.5 py-1 text-xs font-medium hover:bg-black/15"
              aria-label={`Remove label ${l.name}`}
              onClick={() => toggleLabel(l.id)}
            >
              {l.name}
              <span className="opacity-40 group-hover:opacity-80">×</span>
            </button>
          ))}
          <Popover open={picking} onOpenChange={setPicking}>
            <PopoverTrigger
              render={
                <button
                  className="flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium opacity-50 hover:bg-black/10 hover:opacity-80"
                  aria-label="Add label"
                />
              }
            >
              {worn.length === 0 ? <Tag className="size-3.5" /> : <Plus className="size-3.5" />}
              {worn.length === 0 ? "Add label" : "Label"}
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64">
              <LabelPicker
                labels={labels}
                selected={draft.labelIds}
                onToggle={toggleLabel}
                onCreate={(name) => toggleLabel(onCreateLabel(name))}
                onRename={onRenameLabel}
                onDelete={onDeleteLabel}
              />
            </PopoverContent>
          </Popover>
        </div>
        <textarea
          ref={bodyRef}
          rows={1}
          value={draft.body}
          placeholder="Write your note…"
          className="min-h-[50vh] resize-none overflow-hidden bg-transparent text-lg leading-8 outline-none placeholder:opacity-40"
          style={{ color: NOTE_INK }}
          onChange={(e) => onChange({ ...draft, body: e.target.value })}
        />
        </div>
      </div>
    </div>,
    document.body
  );
}

/** The label picker: every label on the account, the note's own checked.
 * Typing filters the list, and Enter — or the create row — makes what was
 * typed and puts it on the note. Each row renames in place and deletes; a
 * delete takes the label off every note. */
function LabelPicker({
  labels,
  selected,
  onToggle,
  onCreate,
  onRename,
  onDelete,
}: {
  labels: CutNoteLabel[];
  selected: string[];
  onToggle: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const typed = query.trim();
  const full = selected.length >= NOTE_LABELS_MAX;
  const shown = labels.filter((l) => l.name.toLowerCase().includes(typed.toLowerCase()));
  const exact = labels.find((l) => l.name.toLowerCase() === typed.toLowerCase());

  /** Enter on the input: put the typed label on the note, making it first
   * when the account has no label by that name. */
  const commitTyped = () => {
    if (!typed || full) return;
    if (exact) {
      if (!selected.includes(exact.id)) onToggle(exact.id);
    } else {
      onCreate(typed);
    }
    setQuery("");
  };

  const commitRename = () => {
    if (!renaming) return;
    const name = renaming.name.trim();
    const held = labels.find((l) => l.id === renaming.id);
    if (name && held && name !== held.name) onRename(renaming.id, name);
    setRenaming(null);
  };

  return (
    <div className="flex max-h-80 w-full flex-col">
      <input
        autoFocus
        value={query}
        placeholder={labels.length === 0 ? "New label…" : "Find or create…"}
        className="border-b border-foreground/10 px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitTyped();
          }
        }}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {shown.map((l) =>
          renaming?.id === l.id ? (
            <input
              key={l.id}
              autoFocus
              value={renaming.name}
              className="w-full rounded-md bg-foreground/5 px-2.5 py-1.5 text-sm outline-none"
              onChange={(e) => setRenaming({ id: l.id, name: e.target.value })}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitRename();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setRenaming(null);
                }
              }}
            />
          ) : (
            <div
              key={l.id}
              className="group flex items-center gap-1 rounded-md hover:bg-foreground/5"
            >
              <button
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left text-sm",
                  full && !selected.includes(l.id)
                    ? "cursor-default opacity-40"
                    : "cursor-pointer",
                )}
                disabled={full && !selected.includes(l.id)}
                onClick={() => onToggle(l.id)}
              >
                <span className="min-w-0 flex-1 truncate">{l.name}</span>
                <Check
                  className={cn(
                    "size-4 shrink-0 opacity-70",
                    !selected.includes(l.id) && "invisible",
                  )}
                />
              </button>
              <button
                className="hidden shrink-0 cursor-pointer rounded p-1 text-muted-foreground group-hover:block hover:text-foreground"
                aria-label={`Rename label ${l.name}`}
                onClick={() => setRenaming({ id: l.id, name: l.name })}
              >
                <Pencil className="size-3.5" />
              </button>
              <button
                className="hidden shrink-0 cursor-pointer rounded p-1 pr-2 text-muted-foreground group-hover:block hover:text-destructive"
                aria-label={`Delete label ${l.name}`}
                onClick={() => onDelete(l.id)}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ),
        )}
        {typed && !exact && !full && (
          <button
            className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-foreground/5"
            onClick={commitTyped}
          >
            <Plus className="size-4 shrink-0 opacity-70" />
            <span className="min-w-0 flex-1 truncate">Create “{typed}”</span>
          </button>
        )}
        {full && (
          <div className="px-2.5 py-2 text-sm text-muted-foreground">
            A note holds {NOTE_LABELS_MAX} labels. Take one off to add another.
          </div>
        )}
        {labels.length === 0 && !typed && (
          <div className="px-2.5 py-2 text-sm text-muted-foreground">
            Type a name to make your first label.
          </div>
        )}
      </div>
    </div>
  );
}
