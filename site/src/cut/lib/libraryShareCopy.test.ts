import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { localBackend } from "@/cut/lib/backend/local";
import { browserBackend } from "@/cut/lib/backend/browser";
import { cloudBackend } from "@/cut/lib/backend/cloud";
import { copyLibraryForSharing } from "@/cut/lib/libraryShareCopy";
import type { LibraryData } from "@/cut/lib/library";
import type { Residency } from "@/cut/lib/residency";

let cleanup = () => {};
afterEach(() => cleanup());
function setup(residency: Residency, failMove = false) {
  const calls: { path: string; method: string; body: Record<string, unknown> }[] = [];
  const reads: string[] = [];
  const source = residency === "browser" ? browserBackend : localBackend;
  const read = spyOn(source, "fetch").mockImplementation(async (path, init) => {
    if (init?.method && init.method !== "GET") throw new Error("Source was modified");
    reads.push(path);
    return new Response(new Blob(["file"], { type: "audio/mpeg" }));
  });
  let serial = 0;
  const cloud = spyOn(cloudBackend, "fetch").mockImplementation(async (path, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    calls.push({ path, method: init?.method ?? "GET", body });
    if (path.endsWith("/presign")) return Response.json({ key: `key-${++serial}`, url: "https://upload.test/file" });
    if (path.endsWith("/move") && failMove) return Response.json({ error: "Failed to file" }, { status: 500 });
    return Response.json({ id: `cloud-${++serial}`, ...body });
  });
  const upload = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== "https://upload.test/file") throw new Error("Unexpected network request");
    return new Response(null, { status: 200 });
  });
  cleanup = () => { read.mockRestore(); cloud.mockRestore(); upload.mockRestore(); };
  const data: LibraryData = {
    folders: [{ id: "root", name: "Sounds", parentId: null, residency, createdAt: 0 }, { id: "child", name: "Music", parentId: "root", residency, createdAt: 0 }],
    assets: [{ id: "asset", fileName: "beat.mp3", name: "Beat", type: "audio", duration: 1, addedAt: 0, folderId: "child", residency }, { id: "outside", fileName: "private.mp3", name: "Private", type: "audio", duration: 1, addedAt: 0, folderId: null, residency }],
    templates: [],
  };
  return { calls, reads, data };
}

describe("library sharing cloud copies", () => {
  for (const residency of ["local", "browser"] as const) {
    test(`${residency} folder copies descendants and preserves the source`, async () => {
      const { calls, reads, data } = setup(residency);
      const target = await copyLibraryForSharing({ kind: "folder", id: "root" }, residency, data);
      expect(target).toEqual({ kind: "folder", id: "cloud-1" });
      expect(reads).toEqual(["/api/cut/library/media/beat.mp3"]);
      expect(calls.filter((call) => call.path === "/api/cut/library/folders").map((call) => call.body.parentId)).toEqual([null, "cloud-1"]);
      expect(calls.find((call) => call.path.endsWith("/move"))?.body.folderId).toBe("cloud-2");
      expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    });
  }
  test("a failed copy removes its cloud assets and folders", async () => {
    const { calls, data } = setup("local", true);
    await expect(copyLibraryForSharing({ kind: "folder", id: "root" }, "local", data)).rejects.toThrow("Could not move item.");
    const deletes = calls.filter((call) => call.method === "DELETE").map((call) => call.path);
    expect(deletes).toEqual(["/api/cut/library/cloud-4", "/api/cut/library/folders/cloud-2", "/api/cut/library/folders/cloud-1"]);
  });
});
