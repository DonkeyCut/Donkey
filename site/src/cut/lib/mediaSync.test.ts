import { describe, expect, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";

// One project's media folder in the browser store, by file name.
const files = new Map<string, File>();
const removed: string[] = [];
const dir = {
  removeEntry: async (name: string) => {
    removed.push(name);
    files.delete(name);
  },
} as unknown as FileSystemDirectoryHandle;

// Other projects' media folders, with a count of every file read from them.
// A read is what a cache measurement costs: one await per file on disk.
type FakeDir = { files: Map<string, File>; reads: number };
const stores = new Map<string, FakeDir>();

function fakeHandle(store: FakeDir, name: string) {
  return {
    kind: "file",
    getFile: async () => {
      store.reads++;
      return store.files.get(name) ?? new File([], name);
    },
    createWritable: async () => {
      const parts: BlobPart[] = [];
      return new WritableStream<Uint8Array<ArrayBuffer>>({
        write: (chunk) => {
          parts.push(chunk);
        },
        close: () => {
          store.files.set(name, new File(parts, name));
        },
      });
    },
  };
}

function fakeDir(store: FakeDir): FileSystemDirectoryHandle {
  return {
    async *[Symbol.asyncIterator]() {
      for (const name of [...store.files.keys()]) {
        yield [name, fakeHandle(store, name)];
      }
    },
    getFileHandle: async (name: string) => fakeHandle(store, name),
    removeEntry: async (name: string) => {
      store.files.delete(name);
    },
  } as unknown as FileSystemDirectoryHandle;
}

const emptyIndex = () => ({ version: 1 as const, folders: [], pendingUploads: [], opens: {} });

await stubModule<typeof import("./backend/browser/opfs")>("./backend/browser/opfs", import.meta.url, {
  supportsBrowserStore: () => true,
  mediaDir: async (id) => {
    const store = stores.get(id);
    return store ? fakeDir(store) : dir;
  },
  projectDir: async () => null,
  listProjectIds: async () => [...stores.keys()],
  readIndex: async () => emptyIndex(),
  updateIndex: async () => emptyIndex(),
  readFileAt: async (d, name) => {
    if (!d) {
      return null;
    }
    const store = [...stores.values()].find((s) => s.files.has(name));
    return store && d !== dir ? (store.files.get(name) ?? null) : (files.get(name) ?? null);
  },
});
await stubModule<typeof import("./chunkCache")>("./chunkCache", import.meta.url, {
  chunkStoreBytes: async () => 0,
  evictChunkBytes: async () => 0,
  prefetchChunks: async () => {},
});
const { localMediaFile, prefetchCloudMedia } = await import("./mediaSync");

describe("localMediaFile", () => {
  test("serves a stored copy", async () => {
    files.set("take.m4a", new File([new Uint8Array(8)], "take.m4a"));
    expect((await localMediaFile("p1", "take.m4a"))?.size).toBe(8);
  });

  test("an empty copy left by an interrupted download is no copy, and goes", async () => {
    // Creating the file handle puts an empty file on disk before a byte is
    // written; a download cut off there leaves it behind.
    files.set("enter.m4a", new File([], "enter.m4a"));
    expect(await localMediaFile("p1", "enter.m4a")).toBeNull();
    expect(removed).toContain("enter.m4a");
  });
});

describe("prefetchCloudMedia", () => {
  test("measures the store's cached copies once for a whole queue", async () => {
    // Another project's cached copy: three files the size check must count.
    const other: FakeDir = { files: new Map(), reads: 0 };
    for (const name of ["a.mp4", "b.m4a", "c.png"]) {
      other.files.set(name, new File([new Uint8Array(16)], name));
    }
    stores.set("other", other);
    stores.set("open", { files: new Map(), reads: 0 });

    // Four small sounds, each landing in turn.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(new Uint8Array(32))) as unknown as typeof fetch;
    const queue = ["1.m4a", "2.m4a", "3.m4a", "4.m4a"].map((fileName) => ({
      fileName,
      url: `https://media.test/${fileName}`,
      type: "audio" as const,
    }));
    const landed: (string | null)[] = [];
    await new Promise<void>((resolve) => {
      prefetchCloudMedia("open", queue, (_name, url) => {
        landed.push(url);
        if (landed.length === queue.length) {
          resolve();
        }
      });
    });
    globalThis.fetch = realFetch;

    // Every file lands, and the other copy is walked once: a walk per file
    // is what held each clip's spinner for seconds while the editor loaded.
    expect(landed.every((url) => url?.startsWith("blob:"))).toBe(true);
    expect(other.reads).toBe(other.files.size);
  });
});
