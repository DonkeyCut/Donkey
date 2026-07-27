import { beforeEach, describe, expect, test } from "bun:test";

import {
  clearProjectThreads,
  mergeThreads,
  readProjectThreads,
  readThreadIds,
  threadsKey,
  writeProjectThreads,
} from "./chatThreads";

// Bun's test runtime has no localStorage; the module reads it per call.
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});

describe("stored chat threads", () => {
  test("a project's threads round trip", () => {
    writeProjectThreads("p1", [{ id: "a", updatedAt: 2 }, { id: "b", updatedAt: 1 }]);
    expect(readProjectThreads("p1").map((t) => t.id)).toEqual(["a", "b"]);
    expect(readThreadIds("p1")).toEqual(new Set(["a", "b"]));
  });

  test("threads are per project, and clearing one leaves the other", () => {
    writeProjectThreads("p1", [{ id: "a" }]);
    writeProjectThreads("p2", [{ id: "b" }]);
    clearProjectThreads("p1");
    expect(readProjectThreads("p1")).toEqual([]);
    expect(readProjectThreads("p2").map((t) => t.id)).toEqual(["b"]);
  });

  test("junk in storage reads as no threads rather than throwing", () => {
    store.set(threadsKey("p1"), "not json");
    expect(readProjectThreads("p1")).toEqual([]);
    store.set(threadsKey("p1"), JSON.stringify([{ id: "a" }, 7, null, { noId: true }]));
    expect(readProjectThreads("p1").map((t) => t.id)).toEqual(["a"]);
  });
});

describe("mergeThreads", () => {
  test("the newest copy of each id wins, newest first", () => {
    const merged = mergeThreads(
      [{ id: "a", updatedAt: 5 }, { id: "b", updatedAt: 1 }],
      [{ id: "a", updatedAt: 9 }, { id: "c", updatedAt: 7 }]
    );
    expect(merged).toEqual([
      { id: "a", updatedAt: 9 },
      { id: "c", updatedAt: 7 },
      { id: "b", updatedAt: 1 },
    ]);
  });

  test("a thread with no timestamp still survives the merge", () => {
    expect(mergeThreads([{ id: "a" }], []).map((t) => t.id)).toEqual(["a"]);
  });
});
