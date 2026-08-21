// Synced notes: one CutNote row per note, written by the iOS app and the
// desktop Notes tab. Both sides merge by last-writer-wins on the client's
// `updatedAt` stamp, and deletes keep tombstone rows so a removal made
// offline on one device still lands on the other.
//
// Notes file into folders — CutFolder rows with scope "note", the same table
// the library and the projects home keep their folders in. Folder ids are
// client-generated like note ids, so a phone can make one offline and push it
// under the id it already filed notes against.
import { prisma } from "@/lib/prisma";
import { caught, err } from "./util";

export interface NoteView {
  id: string;
  title: string;
  body: string;
  colorIndex: number;
  folderId: string | null;
  updatedAt: number;
  deletedAt: number | null;
  createdAt: number;
}

export interface NoteFolderView {
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
  updatedAt: Date;
  deletedAt: Date | null;
  createdAt: Date;
}): NoteView => ({
  id: row.id,
  title: row.title,
  body: row.body,
  colorIndex: row.colorIndex,
  folderId: row.folderId,
  updatedAt: row.updatedAt.getTime(),
  deletedAt: row.deletedAt?.getTime() ?? null,
  createdAt: row.createdAt.getTime(),
});

const folderView = (row: {
  id: string;
  name: string;
  updatedAt: Date;
  createdAt: Date;
}): NoteFolderView => ({
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

export const notesCloud = {
  /** Every note including tombstones, newest first, and the folders they file
   * into. Notes are small and the set is one person's, so the merge reads the
   * whole list. */
  async list(userId: string) {
    const [rows, folders] = await Promise.all([
      prisma.cutNote.findMany({ where: { userId }, orderBy: { updatedAt: "desc" } }),
      prisma.cutFolder.findMany({
        where: { userId, scope: "note" },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    return Response.json({ notes: rows.map(view), folders: folders.map(folderView) });
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
        updatedAt?: number;
      };
      if (typeof body.updatedAt !== "number" || !Number.isFinite(body.updatedAt)) {
        return err("updatedAt is required.", 400);
      }
      const stamp = new Date(body.updatedAt);
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
        const row = await prisma.cutNote.create({ data: { id, userId, ...data } });
        return Response.json(view(row));
      }
      if (existing.updatedAt.getTime() > stamp.getTime()) {
        return Response.json(view(existing));
      }
      const row = await prisma.cutNote.update({ where: { id }, data });
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

  /** Create or rename one folder under a client-chosen id. One call serves
   * both, so a phone that made the folder offline pushes it with the request
   * a rename uses. */
  async putFolder(userId: string, id: string, req: Request) {
    try {
      if (!NOTE_ID.test(id)) return err("Invalid folder id.", 400);
      const body = (await req.json()) as { name?: string };
      const name = String(body.name ?? "").trim().slice(0, 120);
      if (!name) return err("Folder name required.", 400);
      const existing = await prisma.cutFolder.findFirst({
        where: { id, userId, scope: "note" },
        select: { id: true },
      });
      if (!existing) {
        const row = await prisma.cutFolder.create({ data: { id, userId, name, scope: "note" } });
        return Response.json(folderView(row));
      }
      const row = await prisma.cutFolder.update({ where: { id }, data: { name } });
      return Response.json(folderView(row));
    } catch (e) {
      return caught(e, "Could not save the folder.");
    }
  },

  /** Delete one folder. Its notes fall back to the top level rather than
   * going with it. */
  async removeFolder(userId: string, id: string) {
    try {
      await prisma.$transaction(async (tx) => {
        const { count } = await tx.cutFolder.deleteMany({ where: { id, userId, scope: "note" } });
        if (!count) return;
        await tx.cutNote.updateMany({ where: { userId, folderId: id }, data: { folderId: null } });
      });
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not delete the folder.");
    }
  },
};
