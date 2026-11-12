import { beforeEach, describe, expect, test } from "bun:test";

// An in-memory origin-private file system: just the handle surface the store
// reads and writes through.
class FakeDir {
  kind = "directory" as const;
  dirs = new Map<string, FakeDir>();
  files = new Map<string, Blob>();

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDir> {
    let dir = this.dirs.get(name);
    if (!dir) {
      if (!opts?.create) throw new DOMException("Not found", "NotFoundError");
      dir = new FakeDir();
      this.dirs.set(name, dir);
    }
    return dir;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }) {
    if (!this.files.has(name)) {
      if (!opts?.create) throw new DOMException("Not found", "NotFoundError");
      this.files.set(name, new Blob([]));
    }
    const files = this.files;
    return {
      kind: "file" as const,
      async getFile() {
        return new File([files.get(name)!], name, { lastModified: Date.now() });
      },
      async createWritable() {
        return {
          async write(data: Blob | ArrayBuffer | string) {
            files.set(name, data instanceof Blob ? data : new Blob([data]));
          },
          async close() {},
          async abort() {},
        };
      },
    };
  }

  async removeEntry(name: string): Promise<void> {
    this.dirs.delete(name);
    this.files.delete(name);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<[string, { kind: string }]> {
    for (const [name, dir] of this.dirs) yield [name, dir];
    for (const [name] of this.files) yield [name, { kind: "file" }];
  }
}

let root = new FakeDir();
Object.defineProperty(globalThis.navigator, "storage", {
  configurable: true,
  value: { getDirectory: async () => root },
});

const { dispatchBrowserRoute } = await import("./router");
const store = await import("./opfs");

const call = async <T,>(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: T }> => {
  const res = (await dispatchBrowserRoute(path, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
  }))!;
  return { status: res.status, body: (await res.json()) as T };
};

type Folder = { id: string; name: string; parentId?: string | null; createdAt: number };
type Listing = { folders: Folder[]; assets: { id: string; folderId?: string | null }[] };

// The store's account directory, where the root index and the shelf live.
const userDir = () =>
  root.getDirectoryHandle("cut-store", { create: true })
    .then((d) => d.getDirectoryHandle("users", { create: true }))
    .then((d) => d.getDirectoryHandle("-", { create: true }));

/** Write a root index the way stores written before the shared tree hold
 * their project folders. */
async function seedLegacyFolders(folders: Folder[]) {
  (await userDir()).files.set(
    "index.json",
    new Blob([JSON.stringify({ version: 1, folders, pendingUploads: [], opens: {} })]),
  );
}

const legacyFolders = async (): Promise<Folder[]> => {
  const blob = (await userDir()).files.get("index.json");
  return blob ? (JSON.parse(await blob.text()) as { folders: Folder[] }).folders : [];
};

beforeEach(() => {
  root = new FakeDir();
});

describe("browser folders: one tree for projects and files", () => {
  test("project folders move into the shelf with ids and nesting intact, once", async () => {
    await seedLegacyFolders([
      { id: "trips", name: "Trips", parentId: null, createdAt: 1 },
      { id: "japan", name: "Japan", parentId: "trips", createdAt: 2 },
    ]);

    const first = await call<Listing>("/api/cut/library");
    const second = await call<Listing>("/api/cut/library");

    expect(first.body.folders.map((f) => [f.id, f.name, f.parentId ?? null])).toEqual([
      ["trips", "Trips", null],
      ["japan", "Japan", "trips"],
    ]);
    expect(second.body.folders).toEqual(first.body.folders);
    expect(await legacyFolders()).toEqual([]);
    expect((await call<Folder[]>("/api/cut/projects/folders")).body.map((f) => f.id)).toEqual(["trips", "japan"]);
  });

  test("a project files into a folder made on the library side", async () => {
    const folder = (await call<Folder>("/api/cut/library/folders", "POST", { name: "Mixed" })).body;
    const project = (await call<{ id: string }>("/api/cut/projects", "POST", { name: "Cut" })).body;

    const moved = await call<{ ok: boolean }>(`/api/cut/projects/${project.id}/move`, "POST", { folderId: folder.id });
    const missing = await call<{ ok: boolean }>(`/api/cut/projects/${project.id}/move`, "POST", { folderId: "nope" });
    const listed = (await call<{ id: string; folderId: string | null }[]>("/api/cut/projects")).body;

    expect(moved.status).toBe(200);
    expect(missing.status).toBe(404);
    expect(listed.find((p) => p.id === project.id)?.folderId).toBe(folder.id);
  });

  test("deleting a mixed folder takes its subfolders, projects and files", async () => {
    const outer = (await call<Folder>("/api/cut/projects/folders", "POST", { name: "Outer" })).body;
    const inner = (await call<Folder>("/api/cut/library/folders", "POST", { name: "Inner", parentId: outer.id })).body;
    const kept = (await call<{ id: string }>("/api/cut/projects", "POST", { name: "Kept" })).body;
    const filed = (await call<{ id: string }>("/api/cut/projects", "POST", { name: "Filed", folderId: inner.id })).body;

    const res = await call<{ ok: boolean }>(`/api/cut/library/folders/${outer.id}`, "DELETE");
    const projects = (await call<{ id: string }[]>("/api/cut/projects")).body.map((p) => p.id);
    const folders = (await call<Listing>("/api/cut/library")).body.folders;

    expect(res.status).toBe(200);
    expect(projects).toEqual([kept.id]);
    expect(projects).not.toContain(filed.id);
    expect(folders).toEqual([]);
  });

  test("the Uploads folder is made once at the top level", async () => {
    const parent = (await call<Folder>("/api/cut/library/folders", "POST", { name: "Parent" })).body;
    const a = (await call<Folder>("/api/cut/library/folders", "POST", { name: "Uploads", role: "uploads", parentId: parent.id })).body;
    const b = (await call<Folder>("/api/cut/library/folders", "POST", { name: "Renamed later", role: "uploads" })).body;
    const folders = (await call<Listing>("/api/cut/library")).body.folders;

    expect(a.id).toBe("uploads-browser");
    expect(b).toEqual(a);
    expect(a.parentId ?? null).toBeNull();
    expect(folders.filter((f) => f.id === a.id)).toHaveLength(1);
  });
});

describe("browser store: an empty account starts empty", () => {
  test("a write into one account's empty index never reaches the next account's", async () => {
    await store.updateIndex((idx) => {
      idx.opens = { ...idx.opens, p1: 1 };
      idx.folders.push({ id: "f", name: "F", createdAt: 1 });
    });
    root = new FakeDir();

    const fresh = await store.readIndex();

    expect(fresh.opens).toEqual({});
    expect(fresh.folders).toEqual([]);
  });
});
