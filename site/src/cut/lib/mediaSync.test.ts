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

await stubModule<typeof import("./backend/browser/opfs")>("./backend/browser/opfs", import.meta.url, {
  supportsBrowserStore: () => true,
  mediaDir: async () => dir,
  readFileAt: async (_dir, name) => files.get(name) ?? null,
});
const { localMediaFile } = await import("./mediaSync");

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
