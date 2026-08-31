// Synced notes: one CutNote row per note, written by the iOS app and the
// desktop Notes tab. Both sides merge by last-writer-wins on the client's
// `updatedAt` stamp, and deletes keep tombstone rows so a removal made
// offline on one device still lands on the other.
//
// Notes file into folders — CutFolder rows with scope "note", the same table
// the library and the projects home keep their folders in. Folder ids are
// client-generated like note ids, so a phone can make one offline and push it
// under the id it already filed notes against. Folders file into folders the
// same way, through `parentId`; the top level is null.
import { resolveParent } from "@/cut/lib/folderTree";
import { NOTE_LABELS_MAX } from "@/cut/lib/types";
import { prisma } from "@/lib/prisma";
import { caught, err } from "./util";

export interface NoteView {
  id: string;
  title: string;
  body: string;
  colorIndex: number;
  folderId: string | null;
  labelIds: string[];
  updatedAt: number;
  deletedAt: number | null;
  createdAt: number;
}

export interface NoteFolderView {
  id: string;
  name: string;
  parentId: string | null;
  updatedAt: number;
  createdAt: number;
}

export interface NoteLabelView {
  id: string;
  name: string;
  updatedAt: number;
  createdAt: number;
}

const view = (row: {
  id: string;
  title: string;
  body: string;
  colorIndex: number;
  folderId: string | null;
  labelIds: string[];
  updatedAt: Date;
  deletedAt: Date | null;
  createdAt: Date;
}): NoteView => ({
  id: row.id,
  title: row.title,
  body: row.body,
  colorIndex: row.colorIndex,
  folderId: row.folderId,
  labelIds: row.labelIds,
  updatedAt: row.updatedAt.getTime(),
  deletedAt: row.deletedAt?.getTime() ?? null,
  createdAt: row.createdAt.getTime(),
});

const folderView = (row: {
  id: string;
  name: string;
  parentId: string | null;
  updatedAt: Date;
  createdAt: Date;
}): NoteFolderView => ({
  id: row.id,
  name: row.name,
  parentId: row.parentId,
  updatedAt: row.updatedAt.getTime(),
  createdAt: row.createdAt.getTime(),
});

const labelView = (row: {
  id: string;
  name: string;
  updatedAt: Date;
  createdAt: Date;
}): NoteLabelView => ({
  id: row.id,
  name: row.name,
  updatedAt: row.updatedAt.getTime(),
  createdAt: row.createdAt.getTime(),
});

const NOTE_ID = /^[\w-]{1,64}$/;
const TEXT_MAX = 20_000;

/** The folder a note may be filed in: one of this account's note folders, or
 * the top level. An id naming nothing files the note at the top level rather
 * than failing the write — the folder may have been deleted on the other
 * device while this one was offline. */
async function resolveFolder(userId: string, folderId: unknown): Promise<string | null> {
  if (typeof folderId !== "string" || !folderId) return null;
  const row = await prisma.cutFolder.findFirst({
    where: { id: folderId, userId, scope: "note" },
    select: { id: true },
  });
  return row?.id ?? null;
}

/** The folder a note folder may be filed in, by the rules every folder table
 * shares (folderTree.ts), against this account's note folders. */
async function resolveNoteParent(userId: string, id: string, parentId: unknown): Promise<string | null> {
  if (typeof parentId !== "string" || !parentId) return null;
  const folders = await prisma.cutFolder.findMany({
    where: { userId, scope: "note" },
    select: { id: true, parentId: true },
  });
  return resolveParent(folders, id, parentId);
}

/** The labels a note may carry: the ids among `labelIds` that name one of
 * this account's labels. An id naming nothing is dropped rather than failing
 * the write — the label may have been deleted on the other device while this
 * one was offline. `undefined` means the write said nothing about labels — an
 * older client — and the note keeps the labels it has. */
async function resolveLabels(userId: string, labelIds: unknown): Promise<string[] | undefined> {
  if (!Array.isArray(labelIds)) return undefined;
  const asked = [...new Set(labelIds.filter((id): id is string => typeof id === "string"))];
  if (asked.length === 0) return [];
  const rows = await prisma.cutNoteLabel.findMany({
    where: { id: { in: asked }, userId },
    select: { id: true },
  });
  const known = new Set(rows.map((r) => r.id));
  return asked.filter((id) => known.has(id));
}

export const notesCloud = {
  /** Every note including tombstones, newest first, and the folders they file
   * into. Notes are small and the set is one person's, so the merge reads the
   * whole list. */
  async list(userId: string) {
    const [rows, folders, labels] = await Promise.all([
      prisma.cutNote.findMany({ where: { userId }, orderBy: { updatedAt: "desc" } }),
      prisma.cutFolder.findMany({
        where: { userId, scope: "note" },
        orderBy: { createdAt: "asc" },
      }),
      prisma.cutNoteLabel.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
    ]);
    return Response.json({
      notes: rows.map(view),
      folders: folders.map(folderView),
      labels: labels.map(labelView),
    });
  },

  /** Upsert one note. The write applies only when its stamp is not older than
   * the stored row's — last writer wins — and a live write revives a
   * tombstone. The response is whichever version won. */
  async put(userId: string, id: string, req: Request) {
    try {
      if (!NOTE_ID.test(id)) return err("Invalid note id.", 400);
      const body = (await req.json()) as {
        title?: string;
        body?: string;
        colorIndex?: number;
        folderId?: string | null;
        labelIds?: string[];
        updatedAt?: number;
      };
      if (typeof body.updatedAt !== "number" || !Number.isFinite(body.updatedAt)) {
        return err("updatedAt is required.", 400);
      }
      const stamp = new Date(body.updatedAt);
      // Over the cap the write is refused outright: truncating here would
      // answer 200 with a note wearing fewer labels than the person gave it,
      // and the merge would carry that loss back to their other device.
      if (Array.isArray(body.labelIds) && new Set(body.labelIds).size > NOTE_LABELS_MAX) {
        return err(`A note can carry at most ${NOTE_LABELS_MAX} labels.`, 400);
      }
      const labelIds = await resolveLabels(userId, body.labelIds);
      const data = {
        title: String(body.title ?? "").slice(0, 200),
        body: String(body.body ?? "").slice(0, TEXT_MAX),
        colorIndex: Number.isInteger(body.colorIndex) ? (body.colorIndex as number) : 0,
        folderId: await resolveFolder(userId, body.folderId),
        updatedAt: stamp,
        deletedAt: null,
      };
      const existing = await prisma.cutNote.findFirst({ where: { id, userId } });
      if (!existing) {
        const row = await prisma.cutNote.create({
          data: { id, userId, ...data, labelIds: labelIds ?? [] },
        });
        return Response.json(view(row));
      }
      if (existing.updatedAt.getTime() > stamp.getTime()) {
        return Response.json(view(existing));
      }
      const row = await prisma.cutNote.update({
        where: { id },
        // A write that said nothing about labels keeps the ones stored.
        data: labelIds === undefined ? data : { ...data, labelIds },
      });
      return Response.json(view(row));
    } catch (e) {
      return caught(e, "Could not save the note.");
    }
  },

  /** Delete one note: the row stays as a tombstone carrying the delete's own
   * stamp, so both clients drop their copies on the next merge. */
  async remove(userId: string, id: string) {
    try {
      const existing = await prisma.cutNote.findFirst({ where: { id, userId } });
      if (!existing) return Response.json({ ok: true });
      await prisma.cutNote.update({
        where: { id },
        data: { updatedAt: new Date(), deletedAt: new Date() },
      });
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not delete the note.");
    }
  },

  // --- Folders (scope "note") ---

  /** Create, rename or move one folder under a client-chosen id. One call
   * serves all three, so a phone that made the folder offline pushes it with
   * the request a rename uses. A write that says nothing about `parentId`
   * keeps the parent the folder has; the response is the folder as stored,
   * which is where a parent the server could not honor shows up. */
  async putFolder(userId: string, id: string, req: Request) {
    try {
      if (!NOTE_ID.test(id)) return err("Invalid folder id.", 400);
      const body = (await req.json()) as { name?: string; parentId?: string | null };
      const name = String(body.name ?? "").trim().slice(0, 120);
      if (!name) return err("Folder name required.", 400);
      const existing = await prisma.cutFolder.findFirst({
        where: { id, userId, scope: "note" },
        select: { id: true, parentId: true },
      });
      const parentId =
        body.parentId === undefined
          ? (existing?.parentId ?? null)
          : await resolveNoteParent(userId, id, body.parentId);
      if (!existing) {
        const row = await prisma.cutFolder.create({
          data: { id, userId, name, parentId, scope: "note" },
        });
        return Response.json(folderView(row));
      }
      const row = await prisma.cutFolder.update({ where: { id }, data: { name, parentId } });
      return Response.json(folderView(row));
    } catch (e) {
      return caught(e, "Could not save the folder.");
    }
  },

  /** Delete one folder. What it held — its notes and the folders inside it —
   * comes up one level, filed where the folder was. */
  async removeFolder(userId: string, id: string) {
    try {
      await prisma.$transaction(async (tx) => {
        const gone = await tx.cutFolder.findFirst({
          where: { id, userId, scope: "note" },
          select: { parentId: true },
        });
        if (!gone) return;
        await tx.cutFolder.delete({ where: { id } });
        await tx.cutNote.updateMany({
          where: { userId, folderId: id },
          data: { folderId: gone.parentId },
        });
        await tx.cutFolder.updateMany({
          where: { userId, scope: "note", parentId: id },
          data: { parentId: gone.parentId },
        });
      });
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not delete the folder.");
    }
  },

  // --- Labels ---

  /** Create or rename one label under a client-chosen id, the way folders
   * work: one call serves both, so a phone that made the label offline pushes
   * it with the request a rename uses. */
  async putLabel(userId: string, id: string, req: Request) {
    try {
      if (!NOTE_ID.test(id)) return err("Invalid label id.", 400);
      const body = (await req.json()) as { name?: string };
      const name = String(body.name ?? "").trim().slice(0, 60);
      if (!name) return err("Label name required.", 400);
      const existing = await prisma.cutNoteLabel.findFirst({
        where: { id, userId },
        select: { id: true },
      });
      if (!existing) {
        const row = await prisma.cutNoteLabel.create({ data: { id, userId, name } });
        return Response.json(labelView(row));
      }
      const row = await prisma.cutNoteLabel.update({ where: { id }, data: { name } });
      return Response.json(labelView(row));
    } catch (e) {
      return caught(e, "Could not save the label.");
    }
  },

  /** Delete one label and take it off every note that carries it. The notes'
   * own stamps stay put — dropping a dead id is not an edit that should win a
   * merge — and clients drop unknown ids on their own. */
  async removeLabel(userId: string, id: string) {
    try {
      await prisma.$transaction(async (tx) => {
        const { count } = await tx.cutNoteLabel.deleteMany({ where: { id, userId } });
        if (!count) return;
        const notes = await tx.cutNote.findMany({
          where: { userId, labelIds: { has: id } },
          select: { id: true, labelIds: true },
        });
        for (const n of notes) {
          await tx.cutNote.update({
            where: { id: n.id },
            data: { labelIds: n.labelIds.filter((l) => l !== id) },
          });
        }
      });
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not delete the label.");
    }
  },
};
