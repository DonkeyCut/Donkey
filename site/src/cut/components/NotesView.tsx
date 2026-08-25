"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { FolderPlus, Loader2, Plus, StickyNote } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  deleteNote,
  deleteNoteFolder,
  noteColor,
  saveNote,
  saveNoteFolder,
  type CutNote,
} from "@/cut/lib/notes";
import { homeHref, useCutBase } from "@/cut/lib/nav";
import { notesKey, patchNotes, useNotes } from "@/cut/lib/queries";
import { cn } from "@/lib/utils";
import { buildDragGhost, FolderCrumb, FolderShelf, Marquee } from "./desktopFolders";
import { NoteComposer, noteChanged, type NoteDraft } from "./NoteComposer";

// The note paper's ink, matching the iOS app.
const NOTE_INK = "#201a0d";

// A dragged selection of notes, the same shape the library and the projects
// home carry: a JSON array of ids under this page's own MIME type.
const NOTES_MOVE_MIME = "application/x-donkey-notes";

/** Synced notes: written on the phone or here, merged by last writer wins.
 * The phone reads these into its teleprompter, so a script drafted at the
 * desk is on the camera by the time the phone is in hand. Notes file into
 * folders on the desktop-style shelf the library uses. */
export function NotesView() {
  const client = useQueryClient();
  const router = useRouter();
  const base = useCutBase();
  const notes = useNotes();
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [folderCreating, setFolderCreating] = useState(false);

  const list = notes.data?.notes ?? [];
  const folders = notes.data?.folders ?? [];
  // The open folder lives in the URL (?folder=…) so the browser's back button
  // steps folder → root and the location survives reloads.
  const openFolder = useSearchParams().get("folder");
  const openFolderName = folders.find((f) => f.id === openFolder)?.name;
  const shown = list.filter((n) => (n.folderId ?? null) === openFolder);

  const reload = () => void client.invalidateQueries({ queryKey: notesKey });
  const gotoFolder = (id: string | null) =>
    router.push(homeHref(base, "notes", id));

  const openNew = () =>
    setDraft({
      id: crypto.randomUUID(),
      title: "",
      body: "",
      colorIndex: 0,
      // A note written inside a folder is filed there.
      folderId: openFolder,
      isNew: true,
      saved: { title: "", body: "", colorIndex: 0 },
    });
  const openNote = (n: CutNote) =>
    setDraft({
      id: n.id,
      title: n.title,
      body: n.body,
      colorIndex: n.colorIndex,
      folderId: n.folderId ?? null,
      isNew: false,
      saved: { title: n.title, body: n.body, colorIndex: n.colorIndex },
    });

  // A folder tile is on screen the moment it is made, so a note can be filed
  // into it while its own write is still in flight. The write is held here
  // and awaited before any note names that folder, so the server knows the
  // folder by the time it has to resolve the id.
  const folderWrites = useRef(new Map<string, Promise<unknown>>());
  const settleFolder = async (folderId: string | null) => {
    if (folderId) await folderWrites.current.get(folderId);
  };

  /** Save the draft and close the composer. A note that was only read closes
   * untouched, so the list keeps the order it had. */
  const commit = async (d: NoteDraft | null = draft) => {
    if (!d) return;
    const { id, title, body, colorIndex, folderId } = d;
    setDraft(null);
    if (!title.trim() && !body.trim()) return;
    if (!noteChanged(d)) return;
    const now = Date.now();
    const optimistic: CutNote = {
      id,
      title: title.trim() || "Untitled",
      body: body.trim(),
      colorIndex,
      folderId,
      updatedAt: now,
      deletedAt: null,
      createdAt: now,
    };
    patchNotes(client, (prev) => {
      const rest = prev.notes.filter((n) => n.id !== id);
      const existing = prev.notes.find((n) => n.id === id);
      return {
        ...prev,
        notes: [{ ...optimistic, createdAt: existing?.createdAt ?? now }, ...rest],
      };
    });
    await settleFolder(folderId);
    const saved = await saveNote({
      id,
      title: optimistic.title,
      body: optimistic.body,
      colorIndex,
      folderId,
    }).catch(() => null);
    // The server answers with the winning version — this write, or a newer
    // one from the phone.
    if (saved)
      patchNotes(client, (prev) => ({
        ...prev,
        notes: prev.notes.map((n) => (n.id === id ? saved : n)),
      }));
    else reload();
  };

  const remove = async () => {
    if (!draft) return;
    const { id, isNew } = draft;
    setDraft(null);
    if (isNew) return;
    patchNotes(client, (prev) => ({
      ...prev,
      notes: prev.notes.filter((n) => n.id !== id),
    }));
    await deleteNote(id).catch(() => reload());
  };

  /** File a set of notes into a folder (or back to the top level). Each note
   * is its own write, carrying its own last-writer-wins stamp. */
  const moveNotes = async (ids: string[], folderId: string | null) => {
    const moving = list.filter((n) => ids.includes(n.id));
    if (moving.length === 0) return;
    patchNotes(client, (prev) => ({
      ...prev,
      notes: prev.notes.map((n) => (ids.includes(n.id) ? { ...n, folderId } : n)),
    }));
    setSelected(new Set());
    await settleFolder(folderId);
    const saved = await Promise.all(
      moving.map((n) =>
        saveNote({
          id: n.id,
          title: n.title,
          body: n.body,
          colorIndex: n.colorIndex,
          folderId,
        }).catch(() => null),
      ),
    );
    const landed = saved.filter((n): n is CutNote => n !== null);
    if (landed.length !== moving.length) {
      reload();
      return;
    }
    // The server answers with where each note is filed, so a folder that is
    // gone shows its notes back at the top level right away.
    const byId = new Map(landed.map((n) => [n.id, n]));
    patchNotes(client, (prev) => ({
      ...prev,
      notes: prev.notes.map((n) => byId.get(n.id) ?? n),
    }));
  };

  // Leaving the page (the sidebar, the back button) closes the composer the
  // same way its own Done does, so an open draft is never dropped.
  const closing = useRef<() => void>(() => {});
  useEffect(() => {
    closing.current = () => void commit(draft);
  });
  useEffect(() => () => closing.current(), []);

  // Carry the selection (or just this card) as a folder-move payload, with a
  // ghost for a multi-note drag.
  const onCardDragStart = (e: React.DragEvent, id: string) => {
    const ids = selected.has(id) && selected.size > 0 ? Array.from(selected) : [id];
    if (!selected.has(id)) setSelected(new Set([id]));
    e.dataTransfer.setData(NOTES_MOVE_MIME, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = "move";
    if (ids.length > 1) {
      const ghost = buildDragGhost(ids.length, `${ids.length} notes`);
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 18, 16);
      setTimeout(() => ghost.remove(), 0);
    }
  };

  const hasContent = list.length > 0 || folders.length > 0;
  // Closing a note goes back to where it is filed, so a note written inside a
  // folder says that folder's name.
  const draftFolderName = folders.find((f) => f.id === draft?.folderId)?.name;
  // The open note is portaled over the app; this is how it finds the column
  // this list scrolls in and holds it still.
  const pageRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={pageRef} className="mx-auto w-full max-w-6xl px-10 py-9">
      {/* One note at a time, over the whole window. The list stays mounted
          behind it, so closing comes back to the same scroll position. */}
      {draft && (
        <NoteComposer
          draft={draft}
          back={draftFolderName ?? "All notes"}
          from={pageRef}
          onChange={setDraft}
          onClose={() => void commit()}
          onDelete={() => void remove()}
        />
      )}
      <div className="mb-5 flex items-center justify-between gap-4">
        {openFolder === null ? (
          <h1 className="text-lg font-semibold tracking-tight">Notes</h1>
        ) : (
          <FolderCrumb
            root="Notes"
            name={openFolderName ?? "Folder"}
            mime={NOTES_MOVE_MIME}
            onBack={() => gotoFolder(null)}
            onDropOut={(ids) => void moveNotes(ids, null)}
          />
        )}
        <div className="flex items-center gap-2">
          {openFolder === null && (
            <Button variant="outline" onClick={() => setFolderCreating(true)}>
              <FolderPlus data-icon="inline-start" /> New folder
            </Button>
          )}
          <Button onClick={openNew}>
            <Plus data-icon="inline-start" /> New note
          </Button>
        </div>
      </div>

      {/* Folders live at the root and nowhere else, so an open folder shows
        only what is filed in it. */}
      {openFolder === null && (folders.length > 0 || folderCreating) ? (
        <FolderShelf
          folders={folders}
          mime={NOTES_MOVE_MIME}
          creating={folderCreating}
          onCreatingChange={setFolderCreating}
          statOf={(id) => ({
            count: list.filter((n) => (n.folderId ?? null) === id).length,
          })}
          onOpen={gotoFolder}
          onCreate={async (name) => {
            const folder = {
              id: crypto.randomUUID(),
              name,
              updatedAt: Date.now(),
              createdAt: Date.now(),
            };
            patchNotes(client, (prev) => ({
              ...prev,
              folders: [...prev.folders, folder],
            }));
            const write = saveNoteFolder(folder.id, name).catch(() => reload());
            folderWrites.current.set(folder.id, write);
            try {
              await write;
            } finally {
              folderWrites.current.delete(folder.id);
            }
          }}
          onRename={async (id, name) => {
            patchNotes(client, (prev) => ({
              ...prev,
              folders: prev.folders.map((f) => (f.id === id ? { ...f, name } : f)),
            }));
            await saveNoteFolder(id, name).catch(() => reload());
          }}
          onDelete={async (id) => {
            patchNotes(client, (prev) => ({
              folders: prev.folders.filter((f) => f.id !== id),
              notes: prev.notes.map((n) =>
                n.folderId === id ? { ...n, folderId: null } : n,
              ),
            }));
            if (openFolder === id) router.replace(homeHref(base, "notes"));
            await deleteNoteFolder(id).catch(() => reload());
          }}
          onDropIds={(ids, folderId) => void moveNotes(ids, folderId)}
        />
      ) : null}

      {!notes.data && notes.isPending ? (
        <div className="grid place-items-center py-24 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : !hasContent ? (
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
        <Marquee
          className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3"
          selected={selected}
          setSelected={setSelected}
        >
          {shown.map((n) => (
            <button
              key={n.id}
              data-sel-id={n.id}
              draggable
              onDragStart={(e) => onCardDragStart(e, n.id)}
              className={cn(
                "flex min-h-40 cursor-pointer flex-col gap-1.5 rounded-2xl p-4 text-left shadow-sm transition-transform hover:-translate-y-0.5",
                selected.has(n.id) && "ring-2 ring-[#0a84ff]",
              )}
              style={{ backgroundColor: noteColor(n.colorIndex).background, color: NOTE_INK }}
              onClick={() => openNote(n)}
            >
              {n.title && <div className="font-semibold">{n.title}</div>}
              <div className="line-clamp-6 text-sm whitespace-pre-wrap opacity-80">{n.body}</div>
            </button>
          ))}
        </Marquee>
      )}
    </div>
  );
}
