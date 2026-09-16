import { expect, test } from "bun:test";
import type { ProjectDoc } from "@/cut/lib/types";
import {
  CHECKPOINT_KEEP,
  historyState,
  recordCheckpoint,
  restoreCheckpoint,
  type HistoryDb,
} from "./history";

type Row = { id: string; projectId: string; userId: string; seq: number; version: number; doc: unknown; label: string };

/** An in-memory stand-in for the two tables the history touches. */
function fakeDb(project: { id: string; userId: string; version: number; doc: ProjectDoc }) {
  const rows: Row[] = [];
  let nextId = 1;
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (k === "id" && v && typeof v === "object" && "in" in v) return (v.in as string[]).includes(row.id);
      return (row as Record<string, unknown>)[k] === v;
    });
  const db = {
    cutProjectCheckpoint: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((r) => matches(r, where)).sort((a, b) => a.seq - b.seq).map((r) => ({ ...r })),
      findUnique: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
      create: async ({ data }: { data: Omit<Row, "id"> }) => {
        const row = { ...data, id: `cp${nextId++}` };
        rows.push(row);
        return row;
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const keep = rows.filter((r) => !matches(r, where));
        const count = rows.length - keep.length;
        rows.splice(0, rows.length, ...keep);
        return { count };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
    cutProject: {
      findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
        where.id === project.id && where.userId === project.userId ? { version: project.version } : null,
      updateMany: async ({ where, data }: { where: { version: number }; data: { doc: ProjectDoc; version: number } }) => {
        if (where.version !== project.version) return { count: 0 };
        project.version = data.version;
        project.doc = data.doc;
        return { count: 1 };
      },
    },
  };
  return { db: db as unknown as HistoryDb, rows, project };
}

const docWith = (background: string): ProjectDoc =>
  ({ version: 1, name: "Cut", createdAt: 0, updatedAt: 0, assets: [], clips: [], audioClips: [], overlays: [], background }) as ProjectDoc;

test("edits record a line, undo and redo walk it, and a new edit after undo drops the redo branch", async () => {
  const { db, project } = fakeDb({ id: "p", userId: "u", version: 3, doc: docWith("#000") });
  // Version 3 → 4: the first step also writes the baseline.
  await recordCheckpoint(db, { userId: "u", projectId: "p", before: { doc: docWith("#000"), version: 3 }, after: { doc: docWith("#111"), version: 4 }, label: "Black to grey" });
  project.version = 4;
  await recordCheckpoint(db, { userId: "u", projectId: "p", before: { doc: docWith("#111"), version: 4 }, after: { doc: docWith("#222"), version: 5 }, label: "Grey to lighter" });
  project.version = 5;
  expect(await historyState(db, "u", "p", 5)).toEqual({ undo: "Grey to lighter", redo: null });

  const undone = await restoreCheckpoint(db, "u", "p", "undo");
  expect(undone).toEqual({ label: "Grey to lighter", version: 6 });
  expect(project.doc.background).toBe("#111");
  expect(await historyState(db, "u", "p", 6)).toEqual({ undo: "Black to grey", redo: "Grey to lighter" });

  const twice = await restoreCheckpoint(db, "u", "p", "undo");
  expect(twice.label).toBe("Black to grey");
  expect(project.doc.background).toBe("#000");
  await expect(restoreCheckpoint(db, "u", "p", "undo")).rejects.toThrow("Nothing to undo.");

  const redone = await restoreCheckpoint(db, "u", "p", "redo");
  expect(redone.label).toBe("Black to grey");
  expect(project.doc.background).toBe("#111");

  // A fresh edit from here forgets the redo branch.
  await recordCheckpoint(db, { userId: "u", projectId: "p", before: { doc: docWith("#111"), version: project.version }, after: { doc: docWith("#333"), version: project.version + 1 }, label: "New direction" });
  project.version += 1;
  expect(await historyState(db, "u", "p", project.version)).toEqual({ undo: "New direction", redo: null });
});

test("a save from the editor breaks the line, and the next edit starts a new one", async () => {
  const { db, project, rows } = fakeDb({ id: "p", userId: "u", version: 1, doc: docWith("#000") });
  await recordCheckpoint(db, { userId: "u", projectId: "p", before: { doc: docWith("#000"), version: 1 }, after: { doc: docWith("#111"), version: 2 }, label: "First" });
  project.version = 9; // the editor saved
  await expect(restoreCheckpoint(db, "u", "p", "undo")).rejects.toThrow("last saved from the editor");
  await recordCheckpoint(db, { userId: "u", projectId: "p", before: { doc: docWith("#999"), version: 9 }, after: { doc: docWith("#aaa"), version: 10 }, label: "Second" });
  expect(rows.map((r) => [r.seq, r.version, r.label])).toEqual([[0, 9, "Before edits"], [1, 10, "Second"]]);
});

test("the line is capped", async () => {
  const { db, project, rows } = fakeDb({ id: "p", userId: "u", version: 0, doc: docWith("#000") });
  for (let i = 0; i < CHECKPOINT_KEEP + 5; i++) {
    await recordCheckpoint(db, { userId: "u", projectId: "p", before: { doc: docWith("#000"), version: i }, after: { doc: docWith("#111"), version: i + 1 }, label: `Step ${i}` });
    project.version = i + 1;
  }
  expect(rows.length).toBe(CHECKPOINT_KEEP);
  expect(rows[rows.length - 1].label).toBe(`Step ${CHECKPOINT_KEEP + 4}`);
});
