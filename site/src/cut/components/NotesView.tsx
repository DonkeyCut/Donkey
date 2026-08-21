"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, StickyNote, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  deleteNote,
  NOTE_COLORS,
  noteColor,
  saveNote,
  type CutNote,
} from "@/cut/lib/notes";
import { notesKey, patchNotes, useNotes } from "@/cut/lib/queries";
import { cn } from "@/lib/utils";

// The note paper's ink, matching the iOS app.
const NOTE_INK = "#201a0d";

interface Draft {
  id: string;
  title: string;
  body: string;
  colorIndex: number;
  isNew: boolean;
}

/** Synced notes: written on the phone or here, merged by last writer wins.
 * The phone reads these into its teleprompter, so a script drafted at the
 * desk is on the camera by the time the phone is in hand. */
export function NotesView() {
  const client = useQueryClient();
  const notes = useNotes();
  const [draft, setDraft] = useState<Draft | null>(null);

  const openNew = () =>
    setDraft({ id: crypto.randomUUID(), title: "", body: "", colorIndex: 0, isNew: true });
  const openNote = (n: CutNote) =>
    setDraft({ id: n.id, title: n.title, body: n.body, colorIndex: n.colorIndex, isNew: false });

  const commit = async () => {
    if (!draft) return;
    const { id, title, body, colorIndex } = draft;
    setDraft(null);
    if (!title.trim() && !body.trim()) return;
    const now = Date.now();
    const optimistic: CutNote = {
      id,
      title: title.trim() || "Untitled",
      body: body.trim(),
      colorIndex,
      updatedAt: now,
      deletedAt: null,
      createdAt: now,
    };
    patchNotes(client, (prev) => {
      const rest = prev.filter((n) => n.id !== id);
      const existing = prev.find((n) => n.id === id);
      return [{ ...optimistic, createdAt: existing?.createdAt ?? now }, ...rest];
    });
    const saved = await saveNote({
      id,
      title: optimistic.title,
      body: optimistic.body,
      colorIndex,
    }).catch(() => null);
    // The server answers with the winning version — this write, or a newer
    // one from the phone.
    if (saved) patchNotes(client, (prev) => prev.map((n) => (n.id === id ? saved : n)));
    else void client.invalidateQueries({ queryKey: notesKey });
  };

  const remove = async () => {
    if (!draft) return;
    const { id, isNew } = draft;
    setDraft(null);
    if (isNew) return;
    patchNotes(client, (prev) => prev.filter((n) => n.id !== id));
    await deleteNote(id).catch(() => void client.invalidateQueries({ queryKey: notesKey }));
  };

  const list = notes.data ?? [];

  return (
    <div className="mx-auto w-full max-w-6xl px-10 py-9">
      <div className="mb-5 flex items-center justify-between gap-4">
        <h1 className="text-lg font-semibold tracking-tight">Notes</h1>
        <Button onClick={openNew}>
          <Plus data-icon="inline-start" /> New note
        </Button>
      </div>

      {!notes.data && notes.isPending ? (
        <div className="grid place-items-center py-24 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : list.length === 0 ? (
        <button
          className="grid w-full cursor-pointer place-items-center rounded-2xl py-24"
          onClick={openNew}
        >
          <div className="flex flex-col items-center gap-3 text-center">
            <StickyNote className="size-8 text-muted-foreground" />
            <div className="text-base font-medium">No notes yet.</div>
            <p className="text-sm text-muted-foreground">
              Notes sync with the Donkey Cut iOS app — a script written here is ready on the
              phone&apos;s teleprompter.
            </p>
          </div>
        </button>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {list.map((n) => (
            <button
              key={n.id}
              className="flex min-h-40 cursor-pointer flex-col gap-1.5 rounded-2xl p-4 text-left shadow-sm transition-transform hover:-translate-y-0.5"
              style={{ backgroundColor: noteColor(n.colorIndex).background, color: NOTE_INK }}
              onClick={() => openNote(n)}
            >
              {n.title && <div className="font-semibold">{n.title}</div>}
              <div className="line-clamp-6 text-sm whitespace-pre-wrap opacity-80">{n.body}</div>
            </button>
          ))}
        </div>
      )}

      <Dialog open={!!draft} onOpenChange={(o) => (o ? undefined : void commit())}>
        <DialogContent
          className="sm:max-w-lg"
          style={
            draft
              ? { backgroundColor: noteColor(draft.colorIndex).background, color: NOTE_INK }
              : undefined
          }
        >
          <DialogHeader>
            <DialogTitle className="sr-only">{draft?.isNew ? "New note" : "Edit note"}</DialogTitle>
          </DialogHeader>
          {draft && (
            <div className="flex flex-col gap-3">
              <Input
                autoFocus
                value={draft.title}
                placeholder="Title"
                className="border-none bg-transparent px-0 text-base font-semibold shadow-none focus-visible:ring-0 dark:bg-transparent"
                style={{ color: NOTE_INK }}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
              <textarea
                value={draft.body}
                placeholder="Write your note…"
                rows={10}
                className="resize-none bg-transparent text-sm outline-none placeholder:opacity-50"
                style={{ color: NOTE_INK }}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              />
              <DialogFooter className="flex-row items-center sm:justify-between">
                <div className="flex items-center gap-1.5">
                  {NOTE_COLORS.map((c, i) => (
                    <button
                      key={c.background}
                      aria-label={`Note color ${i + 1}`}
                      className={cn(
                        "size-5 cursor-pointer rounded-full border",
                        draft.colorIndex === i ? "border-black/50" : "border-black/15"
                      )}
                      style={{ backgroundColor: c.accent }}
                      onClick={() => setDraft({ ...draft, colorIndex: i })}
                    />
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  {!draft.isNew && (
                    <Button
                      variant="ghost"
                      className="text-destructive hover:bg-black/5 hover:text-destructive"
                      onClick={() => void remove()}
                    >
                      <Trash2 data-icon="inline-start" /> Delete
                    </Button>
                  )}
                  <Button
                    className="bg-black/80 text-white hover:bg-black"
                    onClick={() => void commit()}
                  >
                    Done
                  </Button>
                </div>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
