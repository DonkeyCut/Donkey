import { describe, expect, mock, test } from "bun:test";

/**
 * The byte cache carried across an import's landing.
 *
 * A library clip dragged into a project plays from the library's own URL
 * while the copy runs behind the editor, and everything the session reads —
 * the play, the waveform and filmstrip decodes — lands in the chunk store
 * under the library key. The stored copy is the same bytes under a project
 * key, so the landing adopts what is resident; the failure this guards
 * against is a first session that reads the whole file twice and stutters
 * for it, on a clip that plays smoothly ever after a reload.
 */

// ── an in-memory store standing in for OPFS ─────────────────────────────────

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
        return files.get(name)!;
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

const opfs = await import("./backend/browser/opfs");
mock.module("./backend/browser/opfs", () => ({
  ...opfs,
  supportsBrowserStore: () => true,
  chunksDir: async () => root as never,
  // The real readers over the fake handles.
  readFileAt: async (dir: FakeDir | null, name: string) => {
    if (!dir) return null;
    try {
      return await (await dir.getFileHandle(name)).getFile();
    } catch {
      return null;
    }
  },
  writeFileAt: async (dir: FakeDir, name: string, data: Blob | ArrayBuffer | string) => {
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(data);
    await w.close();
  },
  readJson: async (dir: FakeDir | null, name: string) => {
    if (!dir) return null;
    try {
      const file = await (await dir.getFileHandle(name)).getFile();
      return JSON.parse(await file.text());
    } catch {
      return null;
    }
  },
}));

const { CHUNK_SIZE, adoptChunks, chunkIdentity, encodeResident, decodeResident } = await import(
  "./chunkCache"
);

const signed = (path: string) => `https://media.donkeycut.com${path}?e=123&s=abc`;
const LIB = signed("/cut/u1/library/phone.mp4");
const PROJ = signed("/cut/u1/projects/p1/media/phone.mp4");

/** Seed a source object: `size` bytes with the given chunks resident. */
async function seed(url: string, size: number, resident: number[], opts?: { shortChunk?: number }) {
  const id = chunkIdentity(url)!;
  const dir = await (
    await root.getDirectoryHandle(id.keyHash, { create: true })
  ).getDirectoryHandle(id.versionTag, { create: true });
  const total = Math.ceil(size / CHUNK_SIZE);
  for (const idx of resident) {
    const len =
      opts?.shortChunk === idx ? 7 : Math.min(CHUNK_SIZE, size - idx * CHUNK_SIZE);
    dir.files.set(String(idx), new Blob([new Uint8Array(len).fill(idx + 1)]));
  }
  dir.files.set(
    "meta.json",
    new Blob([
      JSON.stringify({
        key: id.key,
        version: id.version,
        size,
        chunk: CHUNK_SIZE,
        at: 1,
        resident: encodeResident(new Set(resident), total),
      }),
    ])
  );
  return dir;
}

const destDir = async (url: string) => {
  const id = chunkIdentity(url)!;
  return (await root.getDirectoryHandle(id.keyHash)).getDirectoryHandle(id.versionTag);
};

describe("adoptChunks", () => {
  test("the landing carries the resident bytes to the stored key", async () => {
    root = new FakeDir();
    const size = CHUNK_SIZE * 2 + 512;
    await seed(LIB, size, [0, 2]);
    await adoptChunks(LIB, PROJ);
    const dest = await destDir(PROJ);
    expect(dest.files.get("0")!.size).toBe(CHUNK_SIZE);
    expect(dest.files.get("2")!.size).toBe(512);
    expect(dest.files.has("1")).toBe(false);
    const meta = JSON.parse(await dest.files.get("meta.json")!.text());
    expect(meta.key).toBe(chunkIdentity(PROJ)!.key);
    expect(meta.size).toBe(size);
    expect([...decodeResident(meta.resident, 3)].sort()).toEqual([0, 2]);
    // The library keeps its own copy for its own shelf.
    const src = await destDir(LIB);
    expect(src.files.has("0")).toBe(true);
  });

  test("a chunk the disk cannot back stays behind", async () => {
    root = new FakeDir();
    const size = CHUNK_SIZE * 2;
    await seed(LIB, size, [0, 1], { shortChunk: 0 });
    await adoptChunks(LIB, PROJ);
    const dest = await destDir(PROJ);
    expect(dest.files.has("0")).toBe(false);
    expect(dest.files.get("1")!.size).toBe(CHUNK_SIZE);
    const meta = JSON.parse(await dest.files.get("meta.json")!.text());
    expect([...decodeResident(meta.resident, 2)]).toEqual([1]);
  });

  test("a source with nothing resident, or the same key, carries nothing", async () => {
    root = new FakeDir();
    await seed(LIB, CHUNK_SIZE, []);
    await adoptChunks(LIB, PROJ);
    const projId = chunkIdentity(PROJ)!;
    expect(root.dirs.has(projId.keyHash)).toBe(false);
    // The same key at a rotated token is the same object already.
    await adoptChunks(LIB, `${LIB.split("?")[0]}?e=999&s=zzz`);
    expect(root.dirs.size).toBe(1);
  });

  test("an address off the media origin carries nothing", async () => {
    root = new FakeDir();
    await adoptChunks("blob:abc", PROJ);
    await adoptChunks("http://127.0.0.1:41417/f.mp4", PROJ);
    expect(root.dirs.size).toBe(0);
  });
});
