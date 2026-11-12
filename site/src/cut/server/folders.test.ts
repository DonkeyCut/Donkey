import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The engine's data root is read per call, so a temp root set before the
// modules load keeps the test off the user's own Movies folder.
const root = await mkdtemp(path.join(os.tmpdir(), "cut-folders-test-"));
process.env.DONKEY_CUT_DATA_DIR = root;
const projects = await import("./projects");
const library = await import("./library");
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const legacyFile = () => path.join(root, "projects", "folders.json");

beforeEach(async () => {
  await rm(path.join(root, "library"), { recursive: true, force: true });
  await rm(path.join(root, "projects"), { recursive: true, force: true });
});

describe("engine folders: one tree for projects and files", () => {
  test("project folders move into the library with ids and nesting intact, once", async () => {
    await mkdir(path.join(root, "projects"), { recursive: true });
    await writeFile(legacyFile(), JSON.stringify({
      folders: [
        { id: "trips", name: "Trips", parentId: null, createdAt: 1 },
        { id: "japan", name: "Japan", parentId: "trips", createdAt: 2 },
      ],
    }));

    const first = await library.listFolders();
    const second = await library.listFolders();

    expect(first.map((f) => [f.id, f.name, f.parentId ?? null])).toEqual([
      ["trips", "Trips", null],
      ["japan", "Japan", "trips"],
    ]);
    expect(second).toEqual(first);
    expect(JSON.parse(await readFile(legacyFile(), "utf8")).folders).toEqual([]);
  });

  test("a project files into a library folder and refuses one that is gone", async () => {
    const folder = await library.createFolder("Mixed");
    const { id } = await projects.createProject("Cut", folder.id);
    const loose = await projects.createProject("Loose", "nope");

    expect((await projects.readProject(id))?.folderId).toBe(folder.id);
    expect((await projects.readProject(loose.id))?.folderId ?? null).toBeNull();
    await projects.moveProjectToFolder(loose.id, folder.id);
    expect((await projects.readProject(loose.id))?.folderId).toBe(folder.id);
    await expect(projects.moveProjectToFolder(loose.id, "nope")).rejects.toThrow("Folder not found");
  });

  test("deleting a mixed folder takes its subfolders and the projects in them", async () => {
    const outer = await library.createFolder("Outer");
    const inner = await library.createFolder("Inner", outer.id);
    const kept = await projects.createProject("Kept");
    const filed = await projects.createProject("Filed", inner.id);

    await library.deleteFolder(outer.id);

    const ids = (await projects.listProjects()).map((p) => p.id);
    expect(ids).toContain(kept.id);
    expect(ids).not.toContain(filed.id);
    expect(await library.listFolders()).toEqual([]);
  });

  test("the Uploads folder is made once at the top level", async () => {
    const parent = await library.createFolder("Parent");
    const a = await library.createFolder("Uploads", parent.id, "uploads");
    const b = await library.createFolder("Renamed later", null, "uploads");

    expect(a.id).toBe("uploads-mac");
    expect(b).toEqual(a);
    expect(a.parentId ?? null).toBeNull();
    expect((await library.listFolders()).filter((f) => f.id === a.id)).toHaveLength(1);
  });
});

describe("engine folder delete", () => {
  test("takes the projects filed in the folder and leaves a saved template", async () => {
    const trip = await projects.createProject("Trip");
    const saved = await projects.createProject("Saved look");
    const held = new Set(["trips"]);
    for (const p of [trip, saved]) {
      const doc = (await projects.readProject(p.id))!;
      await projects.writeProject(p.id, { ...doc, folderId: "trips", ...(p === saved ? { kind: "template" as const } : {}) });
    }

    await projects.deleteProjectsFiledIn(held);

    expect(await projects.readProject(trip.id)).toBeNull();
    expect(await projects.readProject(saved.id)).not.toBeNull();
  });
});
