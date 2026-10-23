import { beforeEach, describe, expect, mock, test } from "bun:test";
import { DOC_SEQ_HEADER, DOC_WRITER_HEADER } from "@/cut/lib/backend/types";

type Row = {
  id: string;
  userId: string;
  name: string;
  doc: Record<string, unknown>;
  folderId: string | null;
  version: number;
  writer: string | null;
  writerSeq: number | null;
};
let row: Row;
let queries = 0;

const TAB_1 = "00000000-0000-4000-8000-000000000001";
const TAB_2 = "00000000-0000-4000-8000-000000000002";

// The row behaves like Postgres under the versioned write: an update applies
// only when its where-version matches, and bumps the version when it does.
type Data = { doc: Record<string, unknown>; writer: string | null; writerSeq: number | null };
const updateMany = async (args: { where: { version: number }; data: Data }) => {
  queries++;
  if (args.where.version !== row.version) {
    return { count: 0 };
  }
  const { doc, writer, writerSeq } = args.data;
  row = { ...row, doc, writer, writerSeq, version: row.version + 1 };
  return { count: 1 };
};
mock.module("@/lib/prisma", () => ({
  configureDatabasePool: () => {},
  prisma: {
    cutProject: {
      findFirst: async () => {
        queries++;
        return { ...row, previewKey: null, createdAt: new Date(1), updatedAt: new Date(1) };
      },
      updateMany,
    },
  },
}));
const { projectsCloud } = await import("./projects");

const save = (v: number, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  projectsCloud.put("owner", "p1", new Request(`https://donkeycut.com/api/cut-cloud/projects/p1?v=${v}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }));
const as = (writer: string, seq: number) => ({ [DOC_WRITER_HEADER]: writer, [DOC_SEQ_HEADER]: String(seq) });

beforeEach(() => {
  row = {
    id: "p1",
    userId: "owner",
    name: "Growth",
    doc: { name: "Growth", assets: [], clips: [] },
    folderId: null,
    version: 1,
    writer: null,
    writerSeq: null,
  };
  queries = 0;
});

describe("versioned cloud project saves", () => {
  test("a tab saving over its own unacknowledged save is not a conflict", async () => {
    // The first save lands but its response never reaches the tab, so the
    // tab's next save still carries the version it loaded.
    expect((await save(1, { clips: [{ id: "a" }] }, as(TAB_1, 1))).status).toBe(200);
    const res = await save(1, { clips: [{ id: "a" }, { id: "b" }] }, as(TAB_1, 2));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: 3 });
    expect(row.doc.clips).toEqual([{ id: "a" }, { id: "b" }]);
  });

  test("a delayed save its own later save overtook conflicts", async () => {
    // Save 2 commits first; save 1, sent earlier, arrives after it.
    expect((await save(1, { clips: [{ id: "a" }, { id: "b" }] }, as(TAB_1, 2))).status).toBe(200);
    expect((await save(1, { clips: [{ id: "a" }] }, as(TAB_1, 1))).status).toBe(409);
    expect(row.doc.clips).toEqual([{ id: "a" }, { id: "b" }]);
  });

  test("a save over another writer's newer version conflicts", async () => {
    expect((await save(1, { clips: [{ id: "a" }] }, as(TAB_1, 1))).status).toBe(200);
    expect((await save(1, { clips: [{ id: "b" }] }, as(TAB_2, 1))).status).toBe(409);
    expect((await save(1, { clips: [{ id: "b" }] })).status).toBe(409);
    expect(row.doc.clips).toEqual([{ id: "a" }]);
  });

  test("a writerless save ends the last writer's run", async () => {
    // An API client saves over the tab's version; the tab's retry on the
    // old version must not build over it.
    expect((await save(1, { clips: [{ id: "a" }] }, as(TAB_1, 1))).status).toBe(200);
    expect((await save(2, { clips: [{ id: "api" }] })).status).toBe(200);
    expect((await save(1, { clips: [{ id: "b" }] }, as(TAB_1, 2))).status).toBe(409);
    expect(row.doc.clips).toEqual([{ id: "api" }]);
  });

  test("a cross-device conflict reads the row once", async () => {
    await save(1, { clips: [] }, as(TAB_1, 1));
    queries = 0;
    expect((await save(1, { clips: [] }, as(TAB_2, 1))).status).toBe(409);
    expect(queries).toBe(1);
  });

  test("a malformed writer is refused", async () => {
    expect((await save(1, { clips: [] }, as("x".repeat(4096), 1))).status).toBe(400);
    expect((await save(1, { clips: [] }, { [DOC_WRITER_HEADER]: TAB_1 })).status).toBe(400);
    expect((await save(1, { clips: [] }, as(TAB_1, 0))).status).toBe(400);
    expect(row.version).toBe(1);
  });

  test("the writer stays out of the stored doc", async () => {
    await save(1, { clips: [] }, as(TAB_1, 1));
    expect(JSON.stringify(row.doc)).not.toContain(TAB_1);
    expect(row.writer).toBe(TAB_1);
  });
});
