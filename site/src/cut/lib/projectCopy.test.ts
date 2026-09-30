import { describe, expect, mock, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";
import type { CutBackend } from "./backend/types";
import type { ProjectDoc } from "./types";

const uploads: { kind: string; fileName: string }[] = [];
await stubModule("./media", import.meta.url, {
  uploadProjectMediaTo: async (backend: CutBackend, _projectId: string, _blob: Blob, name: string) => {
    uploads.push({ kind: backend.kind, fileName: name });
    return name;
  },
});
await stubModule("./mediaSync", import.meta.url, { localMediaFile: async () => null });
await stubModule("./chatCloud", import.meta.url, {
  fetchCloudThreads: async () => [],
  putCloudThread: async () => {},
});
await stubModule("./chatThreads", import.meta.url, {
  readProjectThreads: () => [],
  writeProjectThreads: () => {},
  mergeThreads: () => [],
});
await stubModule("./linkedLibrary", import.meta.url, {
  ensureLinkedOnCloud: async () => {},
  linkedIdsIn: () => [],
});
const { copyProjectAcross } = await import("./projectCopy");

const doc = {
  id: "src",
  name: "Cut",
  assets: [
    {
      id: "a",
      fileName: "IMG_1.MOV",
      name: "IMG_1.MOV",
      type: "video",
      duration: 4,
      color: { matrix: "bt2020nc", fullRange: false, bitDepth: 10, detected: "apple-log", codec: "apch" },
      proxy: { fileName: "IMG_1.proxy.mp4", sizeBytes: 100 },
    },
    { id: "b", fileName: "b.mp4", name: "b.mp4", type: "video", duration: 2 },
  ],
} as unknown as ProjectDoc;

function backend(kind: CutBackend["kind"]) {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  let saved: ProjectDoc | null = null;
  const fetch = mock(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ path, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (method === "GET" && path === "/api/cut/projects/src") return Response.json(doc);
    if (method === "GET" && path.includes("/media/")) return new Response("bytes");
    if (method === "POST" && path === "/api/cut/projects") return Response.json({ id: "dst" });
    if (method === "PUT") {
      saved = JSON.parse(init!.body as string) as ProjectDoc;
      return Response.json({ ok: true });
    }
    return Response.json({ jobId: "j" });
  });
  return {
    api: { kind, caps: {}, fetch, url: (p: string) => p } as unknown as CutBackend,
    calls,
    saved: () => saved,
  };
}

describe("copying a project with a ProRes master", () => {
  test("carries the proxy and the color record to a Mac", async () => {
    uploads.length = 0;
    const src = backend("browser");
    const dst = backend("local");
    expect(await copyProjectAcross(src.api, dst.api, "src")).toBe("dst");
    expect(uploads.map((u) => u.fileName)).toEqual(["IMG_1.MOV", "IMG_1.proxy.mp4", "b.mp4"]);
    const copied = dst.saved()!;
    expect(copied.assets[0].proxy).toEqual({ fileName: "IMG_1.proxy.mp4", sizeBytes: 100 });
    expect(copied.assets[0].color).toMatchObject({ detected: "apple-log", codec: "apch" });
    expect(dst.calls.some((c) => c.path.endsWith("/proxy"))).toBe(false);
  });

  test("leaves the proxy behind on the way to the cloud and asks the worker for a new one", async () => {
    uploads.length = 0;
    const src = backend("local");
    const dst = backend("cloud");
    await copyProjectAcross(src.api, dst.api, "src");
    expect(uploads.map((u) => u.fileName)).toEqual(["IMG_1.MOV", "b.mp4"]);
    const copied = dst.saved()!;
    expect(copied.assets[0].proxy).toBeUndefined();
    expect(copied.assets[0].color).toMatchObject({ detected: "apple-log" });
    const queued = dst.calls.filter((c) => c.method === "POST" && c.path === "/api/cut/projects/dst/proxy");
    expect(queued.map((c) => c.body)).toEqual([{ file: "IMG_1.MOV" }]);
  });
});
