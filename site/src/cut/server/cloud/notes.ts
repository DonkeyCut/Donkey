// Synced notes: one CutNote row per note, written by the iOS app and the
// desktop Notes tab. Both sides merge by last-writer-wins on the client's
// `updatedAt` stamp, and deletes keep tombstone rows so a removal made
// offline on one device still lands on the other.
import { prisma } from "@/lib/prisma";
import { caught, err } from "./util";

export interface NoteView {
  id: string;
  title: string;
  body: string;
  colorIndex: number;
  updatedAt: number;
  deletedAt: number | null;
  createdAt: number;
}

const view = (row: {
  id: string;
  title: string;
  body: string;
  colorIndex: number;
  updatedAt: Date;
  deletedAt: Date | null;
  createdAt: Date;
}): NoteView => ({
  id: row.id,
  title: row.title,
  body: row.body,
  colorIndex: row.colorIndex,
  updatedAt: row.updatedAt.getTime(),
  deletedAt: row.deletedAt?.getTime() ?? null,
  createdAt: row.createdAt.getTime(),
});

const NOTE_ID = /^[\w-]{1,64}$/;
const TEXT_MAX = 20_000;

export const notesCloud = {
  /** Every note including tombstones, newest first. Notes are small and the
   * set is one person's, so the merge reads the whole list. */
  async list(userId: string) {
    const rows = await prisma.cutNote.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
    });
    return Response.json({ notes: rows.map(view) });
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
};
