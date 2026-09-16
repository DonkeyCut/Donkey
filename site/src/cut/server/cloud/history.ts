// A cloud project's undo history for edits made from outside the editor.
//
// The editor keeps its history in the tab. An edit that arrives as a job — a
// ChatGPT tool call, a headless command — has no tab, so its history lives
// here: one checkpoint per applied step, holding the whole document. The
// rows form one linear line per project, ordered by seq. Each row names the
// project version whose document it holds; a restore writes that document
// back under a fresh version and re-labels the row with it, so the line stays
// walkable in both directions.
//
// The line is anchored to the project's live version. A save from the editor
// moves the version off the line, and the next recorded step starts a new
// line from that state — an outside edit is never silently undone.
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { ProjectDoc } from "@/cut/lib/types";

/** Checkpoints kept per project; the oldest fall off. */
export const CHECKPOINT_KEEP = 30;

export type HistoryDb = Pick<typeof prisma, "cutProjectCheckpoint" | "cutProject">;

type Snapshot = { doc: ProjectDoc; version: number };

const asJson = (doc: ProjectDoc) => doc as unknown as Prisma.InputJsonValue;

async function line(db: HistoryDb, userId: string, projectId: string) {
  return db.cutProjectCheckpoint.findMany({
    where: { projectId, userId },
    orderBy: { seq: "asc" },
    select: { id: true, seq: true, version: true, label: true },
  });
}

/** Record one applied step: the document before it and after it. */
export async function recordCheckpoint(
  db: HistoryDb,
  input: { userId: string; projectId: string; before: Snapshot; after: Snapshot; label: string }
): Promise<void> {
  const { userId, projectId } = input;
  const rows = await line(db, userId, projectId);
  const at = rows.findIndex((r) => r.version === input.before.version);
  let seq: number;
  if (at >= 0) {
    // Continuing the line: whatever was undone past this point is gone.
    const dropped = rows.slice(at + 1).map((r) => r.id);
    if (dropped.length) await db.cutProjectCheckpoint.deleteMany({ where: { id: { in: dropped } } });
    seq = rows[at].seq + 1;
  } else {
    // A new line from the current state.
    if (rows.length) await db.cutProjectCheckpoint.deleteMany({ where: { projectId, userId } });
    await db.cutProjectCheckpoint.create({
      data: { projectId, userId, seq: 0, version: input.before.version, doc: asJson(input.before.doc), label: "Before edits" },
    });
    seq = 1;
  }
  await db.cutProjectCheckpoint.create({
    data: { projectId, userId, seq, version: input.after.version, doc: asJson(input.after.doc), label: input.label },
  });
  const kept = await line(db, userId, projectId);
  const excess = kept.slice(0, Math.max(0, kept.length - CHECKPOINT_KEEP)).map((r) => r.id);
  if (excess.length) await db.cutProjectCheckpoint.deleteMany({ where: { id: { in: excess } } });
}

export class HistoryError extends Error {}

/** What undo and redo would each restore from the given version, by label. */
export async function historyState(
  db: HistoryDb,
  userId: string,
  projectId: string,
  version: number
): Promise<{ undo: string | null; redo: string | null }> {
  const rows = await line(db, userId, projectId);
  const at = rows.findIndex((r) => r.version === version);
  if (at < 0) return { undo: null, redo: null };
  return {
    undo: at > 0 ? rows[at].label : null,
    redo: at + 1 < rows.length ? rows[at + 1].label : null,
  };
}

/** Walk one step along the line and write that document back as a new
 * version. Returns the label of the step undone or redone. */
export async function restoreCheckpoint(
  db: HistoryDb,
  userId: string,
  projectId: string,
  direction: "undo" | "redo"
): Promise<{ label: string; version: number }> {
  const project = await db.cutProject.findFirst({
    where: { id: projectId, userId },
    select: { version: true },
  });
  if (!project) throw new HistoryError("Project not found.");
  const rows = await line(db, userId, projectId);
  const at = rows.findIndex((r) => r.version === project.version);
  if (at < 0)
    throw new HistoryError(
      direction === "undo"
        ? "Nothing to undo: the project was last saved from the editor."
        : "Nothing to redo: the project was last saved from the editor."
    );
  const target = direction === "undo" ? rows[at - 1] : rows[at + 1];
  if (!target) throw new HistoryError(direction === "undo" ? "Nothing to undo." : "Nothing to redo.");
  const row = await db.cutProjectCheckpoint.findUnique({ where: { id: target.id }, select: { doc: true } });
  if (!row) throw new HistoryError("The checkpoint is gone.");
  const doc = { ...(row.doc as unknown as ProjectDoc), updatedAt: Date.now() };
  const version = project.version + 1;
  const updated = await db.cutProject.updateMany({
    where: { id: projectId, userId, version: project.version },
    data: { doc: asJson(doc), name: doc.name, version },
  });
  if (updated.count === 0) throw new HistoryError("The project changed while restoring. Try again.");
  await db.cutProjectCheckpoint.update({ where: { id: target.id }, data: { version } });
  return { label: direction === "undo" ? rows[at].label : target.label, version };
}
