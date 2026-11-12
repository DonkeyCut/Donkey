import { beforeEach, describe, expect, mock, test } from "bun:test";

// An in-memory CutFolder/CutProject pair: enough of Postgres for the folder
// routes, with the scope filter read the way Prisma reads `{ in: [...] }`.
type Folder = { id: string; userId: string; name: string; scope: string; parentId: string | null; createdAt: Date };
type Project = { id: string; userId: string; folderId: string | null };
let folders: Folder[] = [];
let projects: Project[] = [];
const cascaded: string[] = [];

type Scope = string | { in: string[] };
const inScope = (row: Folder, scope?: Scope) =>
  scope === undefined || (typeof scope === "string" ? row.scope === scope : scope.in.includes(row.scope));
type FolderWhere = { id?: string | { in: string[] }; userId?: string; scope?: Scope };
const matches = (row: Folder, w: FolderWhere) =>
  (w.userId === undefined || row.userId === w.userId) &&
  inScope(row, w.scope) &&
  (w.id === undefined || (typeof w.id === "string" ? row.id === w.id : w.id.in.includes(row.id)));

let seq = 0;
mock.module("@/lib/prisma", () => ({
  configureDatabasePool: () => {},
  prisma: {
    cutFolder: {
      findMany: async ({ where }: { where: FolderWhere }) => folders.filter((f) => matches(f, where)),
      findFirst: async ({ where }: { where: FolderWhere }) => folders.find((f) => matches(f, where)) ?? null,
      create: async ({ data }: { data: Omit<Folder, "id" | "createdAt"> }) => {
        const row = { ...data, id: `f${++seq}`, createdAt: new Date(seq) };
        folders.push(row);
        return row;
      },
      upsert: async ({ where, create }: { where: { id: string }; create: Omit<Folder, "createdAt" | "parentId"> }) => {
        const held = folders.find((f) => f.id === where.id);
        if (held) return held;
        const row = { ...create, parentId: null, createdAt: new Date(++seq) };
        folders.push(row);
        return row;
      },
      deleteMany: async ({ where }: { where: FolderWhere }) => {
        const before = folders.length;
        folders = folders.filter((f) => !matches(f, where));
        return { count: before - folders.length };
      },
    },
    cutProject: {
      findMany: async ({ where }: { where: { userId: string; folderId: { in: string[] } } }) =>
        projects.filter((p) => p.userId === where.userId && !!p.folderId && where.folderId.in.includes(p.folderId)),
      update: async ({ where, data }: { where: { id: string }; data: { folderId: string | null } }) => {
        const p = projects.find((x) => x.id === where.id)!;
        p.folderId = data.folderId;
        return p;
      },
    },
    cutLibraryAsset: { findMany: async () => [] },
    cutMediaObject: { findMany: async () => [] },
    cutTemplate: { findMany: async () => [] },
  },
}));

// The project cascade itself has its own tests; here it only has to be the
// path each filed project takes.
const realProjects = await import("./projects");
mock.module("./projects", () => ({
  ...realProjects,
  deleteProjectCascade: async (_userId: string, id: string) => {
    cascaded.push(id);
    projects = projects.filter((p) => p.id !== id);
    return 0;
  },
  getProject: async (userId: string, id: string) => projects.find((p) => p.id === id && p.userId === userId) ?? null,
}));
mock.module("@/cut/server/cloud/notes", () => ({
  notesCloud: { deleteLibraryFolderNotes: async () => {} },
}));

const { libraryCloud } = await import("./library");
const { projectsCloud } = await import("./projects");

const USER = "u1";
const post = (body: unknown) => new Request("http://t/x", { method: "POST", body: JSON.stringify(body) });
const folder = (id: string, scope: string, parentId: string | null = null): Folder =>
  ({ id, userId: USER, name: id, scope, parentId, createdAt: new Date(++seq) });

beforeEach(() => {
  folders = [];
  projects = [];
  cascaded.length = 0;
});

describe("cloud folders: one tree for projects and files", () => {
  test("folders from both scopes list together, through either route", async () => {
    folders = [folder("old-projects", "project"), folder("old-library", "library"), folder("notes", "note")];

    const viaLibrary = (await (await libraryCloud.list(USER)).json()) as { folders: { id: string }[] };
    const viaProjects = (await (await libraryCloud.folders(USER)).json()) as { id: string }[];

    expect(viaLibrary.folders.map((f) => f.id)).toEqual(["old-projects", "old-library"]);
    expect(viaProjects.map((f) => f.id)).toEqual(["old-projects", "old-library"]);
  });

  test("a project files into a folder made on the library side", async () => {
    folders = [folder("mixed", "library")];
    projects = [{ id: "p1", userId: USER, folderId: null }];

    const res = await projectsCloud.move(USER, "p1", post({ folderId: "mixed" }));

    expect(res.status).toBe(200);
    expect(projects[0].folderId).toBe("mixed");
  });

  test("deleting a folder takes the projects filed anywhere under it", async () => {
    folders = [folder("outer", "project"), folder("inner", "library", "outer"), folder("other", "library")];
    projects = [
      { id: "deep", userId: USER, folderId: "inner" },
      { id: "kept", userId: USER, folderId: "other" },
    ];

    await libraryCloud.deleteFolder(USER, "outer");

    expect(cascaded).toEqual(["deep"]);
    expect(folders.map((f) => f.id)).toEqual(["other"]);
  });

  test("the Uploads folder is made once, at the top level, under a derived id", async () => {
    folders = [folder("parent", "library")];

    const a = await (await libraryCloud.createFolder(USER, post({ name: "Uploads", role: "uploads", parentId: "parent" }))).json();
    const b = await (await libraryCloud.createFolder(USER, post({ name: "Other", role: "uploads" }))).json();

    expect(a.id).toBe(`uploads-${USER}`);
    expect(b).toEqual(a);
    expect(a.parentId).toBeNull();
    expect(folders.filter((f) => f.id === a.id)).toHaveLength(1);
  });
});
