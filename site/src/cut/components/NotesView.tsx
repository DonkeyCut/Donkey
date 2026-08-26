"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { FolderPlus, Loader2, Plus, StickyNote } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  deleteNote,
  deleteNoteFolder,
  deleteNoteLabel,
  noteColor,
  saveNote,
  saveNoteFolder,
  saveNoteLabel,
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

/** Write a note out. The list shows it the moment it is written, and the
 * server's answer — this write, or a newer one from the phone — replaces it.
 * False means the write was lost and the list has to be read again. A note
 * with nothing in it, or one that comes back untouched, is left alone, so
 * opening a note to read it keeps the list in the order it had.
 *
 * `settleFolder` waits on a folder's own write, so the server knows the folder
 * by the time a note names it. */
async function writeNote(
  client: QueryClient,
  d: NoteDraft,
  settleFolder: (folderId: string | null) => Promise<void>,
  settleLabels: (labelIds: string[]) => Promise<string[]>,
): Promise<boolean> {
  const { id, title, body, colorIndex, folderId, labelIds } = d;
  if (!title.trim() && !body.trim()) return true;
  if (!noteChanged(d)) return true;
  const now = Date.now();
  const optimistic: CutNote = {
    id,
    title: title.trim() || "Untitled",
    body: body.trim(),
    colorIndex,
    folderId,
    labelIds,
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
  // Only the labels whose own writes landed: one the server never got would be
  // dropped from the note there, and the note would come back missing a label
  // the picker is still showing.
  const live = await settleLabels(labelIds);
  const saved = await saveNote({
    id,
    title: optimistic.title,
    body: optimistic.body,
    colorIndex,
    folderId,
    labelIds: live,
  }).catch(() => null);
  if (!saved) return false;
  patchNotes(client, (prev) => ({
    ...prev,
    notes: prev.notes.map((n) => (n.id === id ? saved : n)),
  }));
  return true;
}

/** A fresh label under a client-minted id, stamped now. */
const mintLabel = (name: string) => ({
  id: crypto.randomUUID(),
  name,
  updatedAt: Date.now(),
  createdAt: Date.now(),
});

/** A stored note, opened for editing. */
const draftOf = (n: CutNote): NoteDraft => ({
  id: n.id,
  title: n.title,
  body: n.body,
  colorIndex: n.colorIndex,
  folderId: n.folderId ?? null,
  labelIds: n.labelIds,
  isNew: false,
  saved: { title: n.title, body: n.body, colorIndex: n.colorIndex, labelIds: n.labelIds },
});

/** Synced notes: written on the phone or here, merged by last writer wins.
 * The phone reads these into its teleprompter, so a script drafted at the
 * desk is on the camera by the time the phone is in hand. Notes file into
 * folders on the desktop-style shelf the library uses. */
export function NotesView() {
  const client = useQueryClient();
  const base = useCutBase();
  const notes = useNotes();
  // The edits made to the note on screen, good only while the URL still names
  // that note. The ref carries the same value where a browser event can reach
  // it, so a back out of a note writes what was typed.
  const [editing, setEditing] = useState<NoteDraft | null>(null);
  const buffer = useRef<NoteDraft | null>(null);
  const edit = (d: NoteDraft) => {
    buffer.current = d;
    setEditing(d);
  };
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [folderCreating, setFolderCreating] = useState(false);

  const list = notes.data?.notes ?? [];
  const folders = notes.data?.folders ?? [];
  const labels = notes.data?.labels ?? [];
  const labelName = new Map(labels.map((l) => [l.id, l.name]));
  // The open folder and the open note both live in the URL (?folder=…&note=…),
  // so the browser's back button — the mouse's too — steps out of the note and
  // then out of the folder, and the location survives a reload.
  const params = useSearchParams();
  const openFolder = params.get("folder");
  const openNoteId = params.get("note");
  const openFolderName = folders.find((f) => f.id === openFolder)?.name;
  const shown = list.filter((n) => (n.folderId ?? null) === openFolder);
  // What the composer shows: the buffer while it belongs to the note the URL
  // names, and the stored note otherwise. A note nobody has typed into has no
  // buffer, and one still being written has no stored note.
  const stored = openNoteId ? list.find((n) => n.id === openNoteId) : undefined;
  const draft =
    editing && editing.id === openNoteId ? editing : stored ? draftOf(stored) : null;

  const reload = () => void client.invalidateQueries({ queryKey: notesKey });
  const notesHref = (folder: string | null, note?: string | null) => {
    const q = new URLSearchParams();
    if (folder) q.set("folder", folder);
    if (note) q.set("note", note);
    const query = q.toString();
    return query ? `${homeHref(base, "notes")}?${query}` : homeHref(base, "notes");
  };
  // Opening a folder or a note only changes this page's query, so it goes
  // through the history API. This page is prefetched as a static shell, and a
  // router push at the URL it is already on has nothing to fetch and stops
  // there — the crumb out of a folder did nothing at all. A pushState reaches
  // the router the same way and `useSearchParams` picks it up, so the back
  // button walks the trail.
  const gotoFolder = (id: string | null) =>
    window.history.pushState(null, "", notesHref(id));

  /** Whether the open note's history entry is ours to take back off the stack.
   * A note arrived at by a link or the forward button already had one. */
  const pushedNote = useRef(false);
  const openAt = (id: string) => {
    window.history.pushState(null, "", notesHref(openFolder, id));
    pushedNote.current = true;
  };

  const openNew = () => {
    const id = crypto.randomUUID();
    edit({
      id,
      title: "",
      body: "",
      colorIndex: 0,
      // A note written inside a folder is filed there.
      folderId: openFolder,
      labelIds: [],
      isNew: true,
      saved: { title: "", body: "", colorIndex: 0, labelIds: [] },
    });
    openAt(id);
  };
  const openNote = (n: CutNote) => openAt(n.id);

  // A folder tile is on screen the moment it is made, so a note can be filed
  // into it while its own write is still in flight. The write is held here
  // and awaited before any note names that folder, so the server knows the
  // folder by the time it has to resolve the id.
  const folderWrites = useRef(new Map<string, Promise<unknown>>());
  const settleFolder = async (folderId: string | null) => {
    if (folderId) await folderWrites.current.get(folderId);
  };
  // The same holds for labels: one made in the picker is on the note at once,
  // and its own write is awaited before a note carries the id to the server.
  // A write that failed answers false, and the id it minted never reaches a
  // note — the server would drop it from labelIds without a word.
  const labelWrites = useRef(new Map<string, Promise<boolean>>());
  const settleLabels = async (labelIds: string[]) => {
    const landed = await Promise.all(
      labelIds.map(async (id) => (await labelWrites.current.get(id)) ?? true),
    );
    return labelIds.filter((_, i) => landed[i]);
  };

  /** Take a label out of the picker, off every note, and off the open draft.
   * What a delete does here, and what a failed create undoes. */
  const forgetLabel = (id: string) => {
    patchNotes(client, (prev) => ({
      ...prev,
      labels: prev.labels.filter((l) => l.id !== id),
      notes: prev.notes.map((n) =>
        n.labelIds.includes(id)
          ? { ...n, labelIds: n.labelIds.filter((l) => l !== id) }
          : n,
      ),
    }));
    const held = buffer.current;
    if (held?.labelIds.includes(id)) {
      edit({
        ...held,
        labelIds: held.labelIds.filter((l) => l !== id),
        saved: { ...held.saved, labelIds: held.saved.labelIds.filter((l) => l !== id) },
      });
    }
  };

  /** Make a label under a fresh id and answer with it. */
  const createLabel = (name: string): string => {
    const label = mintLabel(name);
    patchNotes(client, (prev) => ({ ...prev, labels: [...prev.labels, label] }));
    const write = saveNoteLabel(label.id, name).then(
      () => true,
      () => {
        // The label was never made, so it comes off the picker and off the
        // note that was wearing it rather than lingering as a dead id.
        forgetLabel(label.id);
        return false;
      },
    );
    labelWrites.current.set(label.id, write);
    void write.finally(() => labelWrites.current.delete(label.id));
    return label.id;
  };

  const renameLabel = (id: string, name: string) => {
    patchNotes(client, (prev) => ({
      ...prev,
      labels: prev.labels.map((l) => (l.id === id ? { ...l, name } : l)),
    }));
    void saveNoteLabel(id, name).catch(() => reload());
  };

  /** Delete a label. Every note wearing it — the open draft too — lets it
   * go. */
  const removeLabel = (id: string) => {
    forgetLabel(id);
    void deleteNoteLabel(id).catch(() => reload());
  };

  /** Write a note out and let go of it. */
  const commit = (d: NoteDraft) => {
    setEditing(null);
    void writeNote(client, d, settleFolder, settleLabels).then((ok) => {
      if (!ok) reload();
    });
  };

  /** Take the note's entry back off the history stack. */
  const popNote = () => {
    if (pushedNote.current) {
      pushedNote.current = false;
      window.history.back();
    } else if (openNoteId) {
      window.history.replaceState(null, "", notesHref(openFolder));
    }
  };
  /** Write whatever the composer holds and let go of it. */
  const letGo = () => {
    const d = buffer.current;
    buffer.current = null;
    setEditing(null);
    if (d) commit(d);
  };
  const remove = () => {
    const d = draft;
    buffer.current = null;
    setEditing(null);
    popNote();
    if (!d || d.isNew) return;
    patchNotes(client, (prev) => ({
      ...prev,
      notes: prev.notes.filter((n) => n.id !== d.id),
    }));
    void deleteNote(d.id).catch(() => reload());
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
          labelIds: n.labelIds,
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

  // The same write, reachable from the listeners below, which outlive any one
  // render.
  const closing = useRef<() => void>(() => {});
  useEffect(() => {
    closing.current = letGo;
  });
  /** Done, Escape, or the back arrow. */
  const closeNote = () => {
    letGo();
    popNote();
  };

  // Leaving the page (the sidebar, another tab) writes the open note the same
  // way its own Done does, so a draft is never dropped.
  useEffect(() => () => closing.current(), []);

  // Back and forward are how a note closes, so the browser's own event is what
  // writes it: a history move that leaves the note behind saves the buffer and
  // lets go of it before the list comes back.
  useEffect(() => {
    const onPop = () => {
      pushedNote.current = false;
      const open = new URLSearchParams(window.location.search).get("note");
      if (buffer.current && buffer.current.id !== open) closing.current();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // A note the URL names and nothing answers for — deleted from another
  // device, or a reload of one never written — leaves the list behind.
  const stale = !!openNoteId && !draft && !!notes.data;
  const listHref = notesHref(openFolder);
  useEffect(() => {
    if (stale) window.history.replaceState(null, "", listHref);
  }, [stale, listHref]);

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
          labels={labels}
          onChange={edit}
          onClose={closeNote}
          onDelete={remove}
          onCreateLabel={createLabel}
          onRenameLabel={renameLabel}
          onDeleteLabel={removeLabel}
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
              ...prev,
              folders: prev.folders.filter((f) => f.id !== id),
              notes: prev.notes.map((n) =>
                n.folderId === id ? { ...n, folderId: null } : n,
              ),
            }));
            if (openFolder === id)
              window.history.replaceState(null, "", homeHref(base, "notes"));
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
          {shown.map((n) => {
            const worn = n.labelIds
              .map((id) => labelName.get(id))
              .filter((name): name is string => !!name);
            return (
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
                {worn.length > 0 && (
                  <div className="mt-auto flex flex-wrap gap-1 pt-1.5">
                    {worn.map((name) => (
                      <span
                        key={name}
                        className="rounded-full bg-black/10 px-2 py-0.5 text-[11px] font-medium"
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                )}
              </button>
            );
          })}
        </Marquee>
      )}
    </div>
  );
}
