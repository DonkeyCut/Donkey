"use client";

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { useSearchParams } from "next/navigation";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Trash2 } from "lucide-react";
import { useDeleteKey } from "@/cut/hooks/useDeleteKey";
import { useTabTitle } from "@/cut/hooks/useTabTitle";
import { noteInLibraryFolder, noteRef, type NoteLocation } from "@/cut/lib/noteReference";
import { setRefDragData, clearRefDrag } from "@/cut/lib/assetRef";
import type { Residency } from "@/cut/lib/residency";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  deleteNote,
  deleteNoteLabel,
  noteColor,
  saveNote,
  saveNoteLabel,
  type CutNote,
} from "@/cut/lib/notes";
import { homeHref, useCutBase } from "@/cut/lib/nav";
import { CUT_NOTES } from "@/cut/lib/chatRuntime";
import { dropPendingNote, stageNote, type NoteWrite } from "@/cut/lib/noteOutbox";
import { notesKey, patchNotes, useNotes } from "@/cut/lib/queries";
import { cn } from "@/lib/utils";
import { setObjectDragImage } from "@/cut/lib/assetDrag";
import { additiveClick } from "@/cut/lib/hostKeys";
import { PICKED_RING } from "@/cut/lib/assetPick";
import { Marquee, useTilePicks } from "./desktopFolders";
import { CardActionsMenu } from "./CardActionsMenu";
import { DeleteConfirm, SelectionMenu, usePickWords, useSelectionMenu } from "./selectionMenu";
import { LIBRARY_SQUARE } from "./LibraryCard";
import { NoteComposer, noteChanged, type NoteDraft } from "./NoteComposer";
import { NoteBodyPreview } from "./NoteBodyPreview";

// The note paper's ink, matching the iOS app.
const NOTE_INK = "#201a0d";

// A dragged selection of notes rides the Library's own move: a JSON array of
// ids, filed by the Library's folder tiles and crumb.
const LIBRARY_MOVE_MIME = "application/x-cut-library-move";

/** Write a note out. The list shows it the moment it is written, and the
 * server's answer — this write, or a newer one from the phone — replaces it.
 * False means the write was lost and the list has to be read again. A note
 * that comes back untouched is left alone, so opening a note to read it keeps
 * the list in the order it had. */
async function writeNote(
  client: QueryClient,
  d: NoteDraft,
  settleLabels: (labelIds: string[]) => Promise<string[]>,
): Promise<boolean> {
  const { id, title, body, colorIndex, folderId, labelIds, libraryLocation } = d;
  if (!noteChanged(d)) return true;
  const now = Date.now();
  const optimistic: CutNote = {
    id,
    title: title.trim(),
    body: body.trimEnd(),
    colorIndex,
    folderId,
    labelIds,
    libraryLocation,
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

/** A new note with nothing in it yet, stamped now. */
const blankNote = (folderId: string | null, libraryLocation: NoteLocation | null): CutNote => ({
  id: crypto.randomUUID(),
  title: "",
  body: "",
  colorIndex: 0,
  folderId,
  libraryLocation,
  labelIds: [],
  updatedAt: Date.now(),
  deletedAt: null,
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
  libraryLocation: n.libraryLocation,
  saved: { title: n.title, body: n.body, colorIndex: n.colorIndex, labelIds: n.labelIds },
});

/** The draft's content as a write sends it. */
const noteWrite = (d: NoteDraft): NoteWrite => ({
  ...(d.libraryLocation !== undefined ? { libraryLocation: d.libraryLocation } : {}),
  id: d.id,
  title: d.title.trim(),
  body: d.body.trimEnd(),
  colorIndex: d.colorIndex,
  folderId: d.folderId,
  labelIds: d.labelIds,
});

/** The synced notes filed in one Library folder: written on the phone or
 * here, merged by last writer wins. The phone reads these into its
 * teleprompter, so a script drafted at the desk is on the camera by the time
 * the phone is in hand. The Library's folders hold notes beside its files. */
export type NotesViewHandle = { create: () => void };
type Props = {
  library: { folderId: string | null; residency: Residency; name: string };
  ref?: Ref<NotesViewHandle>;
};
export function NotesView({ library, ref }: Props) {
  const t = useTranslations("home");
  const { pickLabel } = usePickWords();
  const client = useQueryClient();
  const base = useCutBase();
  const notes = useNotes();
  // The edits made to the note on screen, good only while the URL still names
  // that note. The ref carries the same value where a browser event can reach
  // it, so a back out of a note writes what was typed.
  const [failedDraft, setFailedDraft] = useState<NoteDraft | null>(null);
  const [editing, setEditing] = useState<NoteDraft | null>(null);
  const buffer = useRef<NoteDraft | null>(null);
  const edit = (d: NoteDraft) => {
    buffer.current = d;
    setEditing(d);
  };
  // Every note write runs after the one before it, so the server and the list
  // take them in the order they were made.
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const queue = <T,>(job: () => Promise<T>): Promise<T> => {
    const run = writes.current.then(job);
    writes.current = run;
    return run;
  };
  const [deletingNotes, setDeletingNotes] = useState<string[] | null>(null);

  const list = notes.data?.notes ?? [];
  const labels = notes.data?.labels ?? [];
  const labelName = new Map(labels.map((l) => [l.id, l.name]));
  // The open note lives in the URL (?note=…), so the browser's back button —
  // the mouse's too — steps out of the note, and the note survives a reload.
  const params = useSearchParams();
  const openNoteId = params.get("note");
  // What is filed right here: the notes the open Library folder holds.
  const shown = list.filter((n) =>
    noteInLibraryFolder(n, library.folderId, library.folderId === null ? undefined : library.residency));
  // Notes pick the way every tile grid does, and a pick reaches only the
  // notes on screen: a note picked in another folder never rides a delete.
  const shownIds = shown.map((n) => n.id);
  const { picked: selected, setPicked: setSelected, pick: pickTile } = useTilePicks(shownIds);
  const pick = shown.filter((n) => selected.has(n.id));
  // A note inside the pick carries the whole pick; outside it, itself.
  const setOf = (n: CutNote) => (selected.has(n.id) ? pick : [n]);
  const ctx = useSelectionMenu({ picked: selected, setPicked: setSelected, shown: shownIds });
  const ctxSet = ctx.menu ? shown.filter((n) => ctx.menu!.ids.includes(n.id)) : [];
  // What the composer shows: the buffer while it belongs to the note the URL
  // names, and the stored note otherwise. A note nobody has typed into has no
  // buffer, and one still being written has no stored note.
  const stored = openNoteId ? list.find((n) => n.id === openNoteId) : undefined;
  const draft =
    editing && editing.id === openNoteId ? editing : stored ? draftOf(stored) : null;
  // The tab names the open note, as it is typed; without one, the Library
  // names the folder.
  useTabTitle(draft ? draft.title.trim() || t("notes.untitled") : null);

  const reload = () => void client.invalidateQueries({ queryKey: notesKey });
  const notesHref = (note?: string | null) => {
    const q = new URLSearchParams();
    if (library.folderId) q.set("folder", library.folderId);
    if (note) q.set("note", note);
    const query = q.toString();
    return query ? `${homeHref(base, "library")}?${query}` : homeHref(base, "library");
  };
  // Opening a note only changes this page's query, so it goes through the
  // history API. This page is prefetched as a static shell, and a router push
  // at the URL it is already on has nothing to fetch and stops there. A
  // pushState reaches the router the same way and `useSearchParams` picks it
  // up, so the back button walks the trail.

  /** Whether the open note's history entry is ours to take back off the stack.
   * A note arrived at by a link or the forward button already had one. */
  const pushedNote = useRef(false);
  const openAt = (id: string) => {
    window.history.pushState(null, "", notesHref(id));
    pushedNote.current = true;
  };

  /** Make a blank note and open it. It is written at once, so it is a note
   * from the moment it is asked for, and every save after this one edits it. */
  const openNew = () => {
    // A note written inside a folder is filed there.
    const note = blankNote(null, { folderId: library.folderId, residency: library.residency });
    patchNotes(client, (prev) => ({ ...prev, notes: [note, ...prev.notes] }));
    edit(draftOf(note));
    openAt(note.id);
    void queue(async () => {
      const saved = await saveNote({
        id: note.id,
        title: "",
        body: "",
        colorIndex: 0,
        folderId: null,
        labelIds: [],
        libraryLocation: note.libraryLocation,
      }).catch(() => null);
      if (!saved) return reload();
      patchNotes(client, (prev) => ({
        ...prev,
        notes: prev.notes.map((n) => (n.id === note.id ? saved : n)),
      }));
    });
  };
  const openNote = (n: CutNote) => openAt(n.id);
  useImperativeHandle(ref, () => ({ create: openNew }));

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

  /** Write the draft as it stands, after any write still in flight. The open
   * draft takes what was sent as its baseline, so the next save writes only a
   * real change; a lost write hands the old baseline back, so the next save
   * tries again. A note already closed when its write is lost offers a retry. */
  const save = (d: NoteDraft): Promise<boolean> => {
    if (!noteChanged(d)) return Promise.resolve(true);
    const sent = { title: d.title.trim(), body: d.body.trimEnd(), colorIndex: d.colorIndex, labelIds: d.labelIds };
    if (buffer.current?.id === d.id) edit({ ...buffer.current, saved: sent });
    return queue(() => writeNote(client, d, settleLabels)).then((ok) => {
      const held = buffer.current;
      if (ok) setFailedDraft(null);
      else if (held?.id !== d.id) setFailedDraft(d);
      else if (held.saved === sent) edit({ ...held, saved: d.saved });
      return ok;
    });
  };

  /** Take the note's entry back off the history stack. */
  const popNote = () => {
    if (pushedNote.current) {
      pushedNote.current = false;
      window.history.back();
    } else if (openNoteId) {
      window.history.replaceState(null, "", notesHref());
    }
  };
  // A typed edit saves once the note has sat still for the autosave delay.
  const autosave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdAutosave = () => {
    if (autosave.current) clearTimeout(autosave.current);
    autosave.current = null;
  };
  const change = (d: NoteDraft) => {
    edit(d);
    // Every keystroke is saved in this browser at once, so a tab closed
    // before the autosave still has the edit; the autosave sends it. A label
    // still being written stays off until its write lands.
    if (noteChanged(d)) {
      stageNote({ ...noteWrite(d), labelIds: d.labelIds.filter((id) => !labelWrites.current.has(id)) });
    }
    holdAutosave();
    autosave.current = setTimeout(() => {
      autosave.current = null;
      if (buffer.current) void save(buffer.current);
    }, CUT_NOTES.autosaveMs);
  };

  /** Save whatever the composer holds one last time and let go of it. */
  const letGo = () => {
    holdAutosave();
    const d = buffer.current;
    buffer.current = null;
    setEditing(null);
    if (d) void save(d).then((ok) => ok && reload());
  };
  const remove = () => {
    const d = draft;
    holdAutosave();
    buffer.current = null;
    setEditing(null);
    popNote();
    if (!d) return;
    removeNotes([d.id]);
  };
  const removeNotes = (ids: string[]) => {
    const gone = new Set(ids);
    // A pending edit sent on page hide would bring the note back.
    for (const id of ids) {
      dropPendingNote(id);
    }
    patchNotes(client, (prev) => ({
      ...prev,
      notes: prev.notes.filter((n) => !gone.has(n.id)),
    }));
    // Behind any save still queued for it, whose later stamp would bring
    // the note back.
    for (const id of ids) void queue(() => deleteNote(id).catch(() => reload()));
  };

  // The same write, reachable from the listeners below, which outlive any one
  // render.
  const closing = useRef<() => void>(() => {});
  useEffect(() => {
    closing.current = letGo;
  });
  /** Escape or the back arrow. */
  const closeNote = () => {
    letGo();
    popNote();
  };

  // The note editor's code arrives while the list is up, so the first note
  // opens as fast as the rest.
  useEffect(() => {
    void import("./NoteBodyEditor");
  }, []);

  // Leaving the page (the sidebar, another tab) writes the open note the same
  // way its back arrow does, so a draft is never dropped.
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
  const listHref = notesHref();
  useEffect(() => {
    if (stale) window.history.replaceState(null, "", listHref);
  }, [stale, listHref]);

  // Carry the selection (or just this card) as a folder-move payload, with a
  // ghost for a multi-note drag.
  const onCardDragStart = (e: React.DragEvent, id: string) => {
    const ids = selected.has(id) && selected.size > 0 ? Array.from(selected) : [id];
    if (!selected.has(id)) setSelected(new Set([id]));
    e.dataTransfer.setData(LIBRARY_MOVE_MIME, JSON.stringify(ids));
    const note = list.find((n) => n.id === id);
    if (note) setRefDragData(e, noteRef(note));
    e.dataTransfer.effectAllowed = "copyMove";
    setObjectDragImage(e, ids.length, ids, () => setSelected(new Set()));
  };

  // The open note is portaled over the app; this is how it finds the column
  // this list scrolls in and holds it still.
  const pageRef = useRef<HTMLDivElement>(null);
  useDeleteKey(pageRef, pick.length > 0 ? () => setDeletingNotes(pick.map((n) => n.id)) : null);
  // What the confirm names: each note by its title.
  const deletingNames = (deletingNotes ?? []).map((id) => ({
    name: list.find((n) => n.id === id)?.title.trim() || t("notes.untitledNote"),
  }));

  return (
    <div
      ref={pageRef}
      className={shown.length > 0 ? "mb-6" : undefined}
      onContextMenu={ctx.onContextMenu}
    >
      {failedDraft && <p role="alert" className="py-3 text-sm text-destructive">{t("notes.saveFailed")} <button className="underline" onClick={() => { edit(failedDraft); openAt(failedDraft.id); setFailedDraft(null); }}>{t("notes.reopen")}</button></p>}
      {/* One note at a time, over the whole window. The list stays mounted
          behind it, so closing comes back to the same scroll position. */}
      {draft && (
        <NoteComposer
          key={draft.id}
          draft={draft}
          back={library.name}
          from={pageRef}
          labels={labels}
          onChange={change}
          onClose={closeNote}
          onDelete={remove}
          onCreateLabel={createLabel}
          onRenameLabel={renameLabel}
          onDeleteLabel={removeLabel}
        />
      )}
      {notes.isError && <p role="alert" className="py-3 text-sm text-destructive">{t("notes.loadFailed")} <button onClick={reload} className="underline">{t("notes.retry")}</button></p>}
      {shown.length > 0 && (
        <Marquee
          className="flex flex-wrap items-start gap-4"
          // The notes are one row among the Library's files, sized to what
          // they hold; the page's own sweep area is below them.
          rootClassName="relative"
          selected={selected}
          setSelected={setSelected}
        >
          {shown.map((n) => {
            const worn = n.labelIds
              .map((id) => labelName.get(id))
              .filter((name): name is string => !!name);
            return (
              <div
                key={n.id}
                className={cn(
                  "group relative rounded-xl transition-transform hover:-translate-y-0.5",
                  selected.has(n.id) && PICKED_RING,
                )}
              >
                {/* The button carries the tile's mark, so a right-click on it
                    opens the selection menu. */}
                <button
                  data-sel-id={n.id}
                  draggable
                  onDragStart={(e) => onCardDragStart(e, n.id)}
                  onDragEnd={clearRefDrag}
                  className={cn(
                    // Paper stays light in dark mode, like the open note.
                    "light flex cursor-pointer flex-col gap-1.5 text-left shadow-sm",
                    // A note is a file like the rest: the same square a sound
                    // tile is, here and in the Library.
                    "overflow-hidden rounded-xl p-3",
                  )}
                  style={{
                    backgroundColor: noteColor(n.colorIndex).background,
                    color: NOTE_INK,
                    width: LIBRARY_SQUARE,
                    height: LIBRARY_SQUARE,
                  }}
                  onClick={(e) => {
                    if (!additiveClick(e)) {
                      openNote(n);
                      return;
                    }
                    e.preventDefault();
                    pickTile(e, n.id, shownIds);
                  }}
                >
                  {/* Clear of the actions button that takes the corner on hover. */}
                  {n.title && <div className="truncate pr-6 text-[13px] font-semibold">{n.title}</div>}
                  <NoteBodyPreview body={n.body} lines={5} className="text-[12px] opacity-80" />
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
                {/* The same menu every Library file carries. A picked note
                    deletes the whole pick with it, the way a file does. */}
                <CardActionsMenu
                  className="absolute top-1.5 right-1.5"
                  onDelete={() => setDeletingNotes(setOf(n).map((m) => m.id))}
                />
              </div>
            );
          })}
        </Marquee>
      )}
      <SelectionMenu menu={ctxSet.length > 0 ? ctx.menu : null} onClose={ctx.close}>
        <DropdownMenuItem variant="destructive" onClick={() => setDeletingNotes(ctxSet.map((n) => n.id))}>
          <Trash2 /> {t("notes.delete")}
        </DropdownMenuItem>
      </SelectionMenu>
      <DeleteConfirm
        open={deletingNotes !== null}
        title={t("notes.deleteTitle", { what: pickLabel([], deletingNames, "note", 0) })}
        description={t("notes.removedFromPhone", { count: deletingNotes?.length ?? 0 })}
        onClose={() => setDeletingNotes(null)}
        onConfirm={() => {
          const ids = deletingNotes;
          setDeletingNotes(null);
          if (ids) removeNotes(ids);
        }}
      />
    </div>
  );
}
