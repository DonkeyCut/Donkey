import { describe, expect, mock, test } from "bun:test";
import { createNotesCloud } from "@/cut/server/cloud/notes";
import type { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
const location = { residency: "local", folderId: "brand" };
const row = { id: "n1", userId: "owner", title: "Script", body: "Words", colorIndex: 1, labelIds: [], folderId: null, libraryLocation: location, createdAt: new Date(1), updatedAt: new Date(1), deletedAt: null };
function harness() {
  const db = {
    cutNote: {
      findFirst: mock(async (args: unknown) => { void args; return row as typeof row | null; }),
      update: mock(async (args: unknown) => { void args; return row; }), create: mock(async (args: unknown) => { void args; return row; }),
      updateMany: mock(async (args: unknown) => { void args; return { count: 1 }; }),
    },
    cutFolder: { findFirst: mock(async (args: unknown) => { void args; return null as { id: string } | null; }) },
    cutNoteLabel: { findMany: mock(async (args: unknown) => { void args; return []; }) },
  };
  return { db, api: createNotesCloud(db as unknown as typeof prisma) };
}
const request = (body: unknown) => new Request("https://donkeycut.com/api/cut-cloud/notes/n1", { method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
describe("synced Library notes", () => {
  test("reads enforce ownership and hide tombstones", async () => {
    const { api, db } = harness();
    expect((await api.get("owner", "n1")).status).toBe(200);
    expect(db.cutNote.findFirst.mock.calls[0][0]).toEqual({ where: { id: "n1", userId: "owner", deletedAt: null } });
    db.cutNote.findFirst.mockResolvedValue(null);
    expect((await api.get("stranger", "n1")).status).toBe(404);
  });
  test("phone writes keep Library placement when omitted", async () => {
    const { api, db } = harness();
    expect((await api.put("owner", "n1", request({ title: "Phone edit", body: "New text", updatedAt: 2 }))).status).toBe(200);
    const update = db.cutNote.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(update.data.title).toBe("Phone edit");
    expect("libraryLocation" in update.data).toBe(false);
  });
  test("browser and Mac placements work; cloud folders require ownership", async () => {
    for (const residency of ["browser", "local"] as const) {
      const { api, db } = harness();
      expect((await api.put("owner", "n1", request({ updatedAt: 2, libraryLocation: { ...location, residency } }))).status).toBe(200);
      expect(db.cutNote.update.mock.calls[0][0]).toMatchObject({ data: { libraryLocation: { ...location, residency } } });
    }
    const { api, db } = harness();
    expect((await api.put("owner", "n1", request({ updatedAt: 2, libraryLocation: { ...location, residency: "cloud" } }))).status).toBe(404);
    expect(db.cutFolder.findFirst.mock.calls[0][0]).toMatchObject({ where: { userId: "owner", id: "brand", scope: "library" } });
    expect(db.cutNote.update.mock.calls.length).toBe(0);
    db.cutFolder.findFirst.mockResolvedValue({ id: "brand" });
    expect((await api.put("owner", "n1", request({ updatedAt: 2, libraryLocation: { ...location, residency: "cloud" } }))).status).toBe(200);
  });
  test("invalid placements fail; explicit null unfiles", async () => {
    const { api, db } = harness();
    expect((await api.put("owner", "n1", request({ updatedAt: 2, libraryLocation: { residency: "other", folderId: "x" } }))).status).toBe(400);
    expect((await api.put("owner", "n1", request({ updatedAt: 2, libraryLocation: null }))).status).toBe(200);
    expect(db.cutNote.update.mock.calls[0][0]).toMatchObject({ data: { libraryLocation: Prisma.DbNull } });
  });
  test("old phone writes cannot replace newer text or placement", async () => {
    const { api, db } = harness();
    const res = await api.put("owner", "n1", request({ title: "Old", updatedAt: 0 }));
    expect(await res.json()).toMatchObject({ title: "Script", libraryLocation: location });
    expect(db.cutNote.update.mock.calls.length).toBe(0);
  });
  test("folder deletion unfiles only matching owner, shelf, and folders", async () => {
    const { api, db } = harness();
    await api.unfileLibraryFolders("owner", "local", ["brand", "child"]);
    expect(db.cutNote.updateMany.mock.calls[0][0]).toEqual({ where: { userId: "owner", AND: [
      { libraryLocation: { path: ["residency"], equals: "local" } },
      { OR: ["brand", "child"].map((id) => ({ libraryLocation: { path: ["folderId"], equals: id } })) },
    ] }, data: { libraryLocation: Prisma.DbNull } });
  });
});
