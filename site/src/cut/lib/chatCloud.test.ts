import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { bindCutMode, releaseCutMode } from "./backend";
import { cloudBackend, knownDocVersion } from "./backend/cloud";
import { ensureCloudThreads, flushCloudThreadSaves, putCloudThread, queueCloudThreadSave } from "./chatCloud";
import { CLOUD_THREAD_BUDGET } from "./chatCompact";
import { chatThreadDeleted, deleteStoredThread, readProjectThreads, threadSaveFailure, writeProjectThreads } from "./chatThreads";

const originalFetch = globalThis.fetch;
const storage = new Map<string, string>();
let storageReads = 0;
beforeEach(() => {
  storage.clear();
  storageReads = 0;
  Object.assign(globalThis, { localStorage: {
    getItem: (key: string) => { storageReads++; return storage.get(key) ?? null; },
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  } });
  bindCutMode("cloud");
});
afterEach(() => { globalThis.fetch = originalFetch; releaseCutMode(); });

const stubFetch = (fn: (url: URL, init?: RequestInit) => Response) => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    fn(new URL(String(input), "https://example.test"), init)) as typeof fetch;
};

test("unchanged polls read metadata without loading transcripts or local history", async () => {
  let bodyReads = 0;
  stubFetch((url) => {
    if (url.searchParams.has("revisions")) return Response.json([{ id: "a", revision: "1" }]);
    bodyReads++;
    return Response.json([{ id: "a", updatedAt: 1 }]);
  });
  await ensureCloudThreads("unchanged", true);
  expect(bodyReads).toBe(1);
  storageReads = 0;
  await ensureCloudThreads("unchanged", true);
  expect(bodyReads).toBe(1);
  expect(storageReads).toBe(0);
});

test("a remote deletion wins over a newer stale local transcript", async () => {
  writeProjectThreads("deleted", [{ id: "a", updatedAt: 100 }]);
  let puts = 0;
  stubFetch((url, init) => {
    if (init?.method === "PUT") puts++;
    return Response.json(url.searchParams.has("revisions")
      ? [{ id: "a", revision: "2" }]
      : [{ id: "a", updatedAt: 2, deleted: true }]);
  });
  await ensureCloudThreads("deleted", true);
  expect(chatThreadDeleted("deleted", "a")).toBe(true);
  expect(puts).toBe(0);
});

test("an offline deletion is sent before an old server copy can return", async () => {
  writeProjectThreads("offline-delete", [{ id: "a", updatedAt: 1 }]);
  deleteStoredThread("offline-delete", "a");
  let deletes = 0;
  stubFetch((url, init) => {
    if (init?.method === "DELETE") { deletes++; return Response.json({ ok: true }); }
    return Response.json(url.searchParams.has("revisions")
      ? [{ id: "a", revision: "1" }]
      : [{ id: "a", updatedAt: 1 }]);
  });
  await ensureCloudThreads("offline-delete", true);
  expect(deletes).toBe(1);
  expect(readProjectThreads("offline-delete")[0].deleted).toBe(true);
});

test("observing a newer scene document preserves the loaded cloud save base", async () => {
  let version = "1";
  let putBase: string | null = null;
  stubFetch((url, init) => {
    if (init?.method === "PUT") {
      putBase = url.searchParams.get("v");
      return Response.json({ version: 3 });
    }
    return Response.json({}, { headers: { "x-cut-doc-version": version } });
  });
  const path = "/api/cut/projects/observe-scene";
  await cloudBackend.fetch(path);
  version = "2";
  await cloudBackend.fetch(path, { observe: true });
  expect(knownDocVersion("observe-scene")).toBe("1");
  await cloudBackend.fetch(path, { method: "PUT", body: "{}" });
  expect(putBase).toBe("1");
});

test("a long thread goes up compacted, and a refused cloud save is told until one lands", async () => {
  const parts = Array.from({ length: 295 }, (_, i) => ({
    type: "tool-listen_audio", toolCallId: `c${i}`, state: "output-available", input: {},
    output: { name: "voice", audio: `data:audio/wav;base64,${"x".repeat(20_000)}` },
  }));
  const thread = { id: "long", updatedAt: 1, messages: [{ id: "a", role: "assistant", parts }] };
  const bodies: string[] = [];
  let status = 500;
  stubFetch((_url, init) => {
    if (init?.method === "PUT") { bodies.push(String(init.body)); return Response.json({}, { status }); }
    return Response.json([]);
  });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    queueCloudThreadSave("compact", thread);
    await flushCloudThreadSaves();
    expect(bodies[0].length).toBeLessThanOrEqual(CLOUD_THREAD_BUDGET);
    expect(JSON.parse(bodies[0]).messages[0].parts).toHaveLength(295);
    expect(threadSaveFailure()).toContain("cloud");
    await expect(putCloudThread(cloudBackend, "compact", thread)).rejects.toThrow();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("cloud"))).toHaveLength(1);
    status = 200;
    queueCloudThreadSave("compact", { ...thread, updatedAt: 2 });
    await flushCloudThreadSaves();
    expect(threadSaveFailure()).toBeNull();
  } finally {
    warn.mockRestore();
  }
});
