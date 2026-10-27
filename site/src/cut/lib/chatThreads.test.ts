import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Chat } from "@ai-sdk/react";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";

import {
  chatThreadDeleted,
  deleteStoredThread,
  clearProjectThreads,
  flushThreadSaves,
  loadProjectThreads,
  mergeThreads,
  readActiveChat,
  readProjectThreads,
  readQueuedRows,
  readThreadIds,
  recordThread,
  subscribeThreadSaveFailure,
  sweepGoneProjectThreads,
  threadSaveFailure,
  threadsKey,
  threadsLoaded,
  useThreadStore,
  writeActiveChat,
  writeProjectThreads,
  writeQueuedRows,
  writeRawThreads,
  type ThreadStore,
} from "./chatThreads";

// Bun's test runtime has no localStorage; the module reads it per call.
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    get length() { return store.size; },
    key: (i: number) => [...store.keys()][i] ?? null,
  };
  // With no IndexedDB here the threads fall back to localStorage, as a
  // browser without one does.
  useThreadStore(null);
});

/** IndexedDB as the thread store sees it: one list per project, and a quota
 * that refuses a write past it the way the browser does. */
function memoryStore(quota = Infinity) {
  const lists = new Map<string, unknown[]>();
  const queues = new Map<string, Record<string, unknown[]>>();
  const size = () => [...lists.values()].reduce((n, list) => n + JSON.stringify(list).length, 0);
  const threadStore: ThreadStore = {
    read: async (projectId) => lists.get(projectId),
    write: async (projectId, list) => {
      const before = lists.get(projectId);
      lists.set(projectId, list);
      if (size() > quota) {
        if (before) lists.set(projectId, before); else lists.delete(projectId);
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      }
    },
    remove: async (projectId) => { lists.delete(projectId); queues.delete(projectId); },
    projects: async () => [...lists.keys()],
    readQueues: async (projectId) => queues.get(projectId),
    writeQueues: async (projectId, record) => {
      if (Object.keys(record).length) queues.set(projectId, record); else queues.delete(projectId);
    },
  };
  return { threadStore, lists, queues, size };
}

const big = (id: string, updatedAt: number, chars: number) => ({ id, updatedAt, messages: [{ id: "m", role: "user", parts: [{ type: "text", text: "x".repeat(chars) }] }] });

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

test("a deleted thread stays deleted after a late completion or stale remote save", () => {
  writeProjectThreads("p", [{ id: "a", updatedAt: 1 }]);
  deleteStoredThread("p", "a");
  writeProjectThreads("p", [{ id: "a", updatedAt: Date.now() + 10_000 }]);
  expect(chatThreadDeleted("p", "a")).toBe(true);
  expect(readThreadIds("p").has("a")).toBe(false);
  expect(mergeThreads([{ id: "a", deleted: true }], [{ id: "a", updatedAt: 999 }])[0].deleted).toBe(true);
});

// A screen-locked, minimised, or background tab paints nothing: no animation
// frame fires and React may commit nothing for minutes, while the stream and
// the tools keep running. The stored thread has to follow the chat itself.
describe("a running thread's record", () => {
  const chunks = (calls: number): UIMessageChunk[] => [
    { type: "start", messageId: "turn-1" },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "Building it." },
    { type: "text-end", id: "t1" },
    ...Array.from({ length: calls }, (_, i): UIMessageChunk[] => [
      { type: "tool-input-available", toolCallId: `call-${i}`, toolName: "add_title", input: { text: `CLIP ${i}` } },
      { type: "tool-output-available", toolCallId: `call-${i}`, output: { id: `title-${i}` } },
    ]).flat(),
    { type: "text-start", id: "t2" },
    { type: "text-delta", id: "t2", delta: "FINAL: every title is in." },
    { type: "text-end", id: "t2" },
    { type: "finish" },
  ];
  const stored = () => (readProjectThreads("p")[0] as { messages?: UIMessage[] } | undefined)?.messages ?? [];
  const tools = (messages: UIMessage[]) => messages.at(-1)?.parts.filter((p) => p.type.startsWith("tool-")) ?? [];

  test("keeps saving every part while the page cannot paint", async () => {
    const page = globalThis as unknown as Record<string, unknown>;
    const previous = { raf: page.requestAnimationFrame, document: page.document };
    page.requestAnimationFrame = () => 0;
    page.document = { hidden: true, visibilityState: "hidden" };
    try {
      const all = chunks(296);
      let sent = 0;
      let release = () => {};
      const transport: ChatTransport<UIMessage> = {
        sendMessages: async () => new ReadableStream<UIMessageChunk>({
          async pull(controller) {
            // The turn pauses partway, as a long tool would, for the
            // record to be read mid-turn.
            if (sent === 150) await new Promise<void>((resolve) => { release = resolve; });
            else await new Promise((resolve) => setTimeout(resolve, 0));
            if (sent < all.length) controller.enqueue(all[sent++]);
            else controller.close();
          },
        }),
        reconnectToStream: async () => null,
      };
      // Nothing renders this chat: no component, no effect, no frame.
      const chat = new Chat<UIMessage>({ id: "t", transport });
      const recorder = recordThread(chat, (messages) => writeRawThreads("p", [{ id: "t", updatedAt: Date.now(), messages }]), 5);
      const turn = chat.sendMessage({ text: "build the titles" });
      while (sent < 150) await new Promise((resolve) => setTimeout(resolve, 1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(tools(stored()).length).toBeGreaterThan(60);
      release();
      await turn;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const final = stored();
      expect(tools(final)).toHaveLength(296);
      expect(tools(final).every((p) => (p as { state?: string }).state === "output-available")).toBe(true);
      expect(final.at(-1)?.parts.at(-1)).toMatchObject({ type: "text", text: "FINAL: every title is in." });
      recorder.stop();
    } finally {
      page.requestAnimationFrame = previous.raf;
      page.document = previous.document;
    }
  });

  test("a thread read back from storage is not saved back over it", async () => {
    const chat = new Chat<UIMessage>({ id: "t", transport: { sendMessages: async () => new ReadableStream(), reconnectToStream: async () => null } });
    let saves = 0;
    const recorder = recordThread(chat, () => { saves++; }, 1);
    recorder.quietly(() => { chat.messages = [{ id: "a", role: "user", parts: [{ type: "text", text: "from another tab" }] }]; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(saves).toBe(0);
    chat.messages = [...chat.messages, { id: "b", role: "user", parts: [{ type: "text", text: "typed here" }] }];
    recorder.flush();
    expect(saves).toBe(1);
    recorder.stop();
  });
});

describe("where threads are kept", () => {
  test("history goes to the thread store, past what localStorage could hold", async () => {
    const { threadStore, lists } = memoryStore();
    useThreadStore(threadStore);
    await loadProjectThreads("p");
    // Six megabytes: more than a whole origin's localStorage.
    writeProjectThreads("p", [big("a", 1, 3_000_000), big("b", 2, 3_000_000)]);
    await flushThreadSaves();
    expect((lists.get("p") as { id: string }[]).map((t) => t.id)).toEqual(["a", "b"]);
    expect(store.has(threadsKey("p"))).toBe(false);
    expect(threadSaveFailure()).toBeNull();
  });

  test("localStorage history moves to the store on first read, freeing the space", async () => {
    const { threadStore, lists } = memoryStore();
    store.set(threadsKey("p1"), JSON.stringify([{ id: "a", updatedAt: 1 }]));
    store.set(threadsKey("gone"), JSON.stringify([{ id: "b", updatedAt: 2 }]));
    store.set("cut-ai-model", "claude");
    useThreadStore(threadStore);
    expect(threadsLoaded("p1")).toBe(false);
    await loadProjectThreads("p1");
    expect(threadsLoaded("p1")).toBe(true);
    expect(readProjectThreads("p1").map((t) => t.id)).toEqual(["a"]);
    // Every project's history moves, not just the one opened.
    expect([...lists.keys()].sort()).toEqual(["gone", "p1"]);
    expect([...store.keys()]).toEqual(["cut-ai-model"]);
  });

  test("a store that already holds a project keeps the newest copy of each thread", async () => {
    const { threadStore, lists } = memoryStore();
    lists.set("p", [{ id: "a", updatedAt: 5, title: "store" }]);
    store.set(threadsKey("p"), JSON.stringify([{ id: "a", updatedAt: 3, title: "local" }, { id: "b", updatedAt: 4 }]));
    useThreadStore(threadStore);
    await loadProjectThreads("p");
    expect(readProjectThreads("p")).toEqual([{ id: "a", updatedAt: 5, title: "store" } as never, { id: "b", updatedAt: 4 }]);
  });

  test("a deleted project takes its threads, open chat, queue and read marks with it", async () => {
    const { threadStore, lists } = memoryStore();
    useThreadStore(threadStore);
    await loadProjectThreads("p");
    writeProjectThreads("p", [{ id: "a", updatedAt: 1 }]);
    writeActiveChat("p", "a");
    store.set("cut-ai-queue-p-a", "[]");
    store.set("cut-ai-seen-replies-p", "{}");
    store.set("cut-ai-queue-other-a", "[]");
    await flushThreadSaves();
    clearProjectThreads("p");
    await flushThreadSaves();
    expect(lists.has("p")).toBe(false);
    expect(readProjectThreads("p")).toEqual([]);
    expect(readActiveChat("p")).toBeNull();
    expect([...store.keys()]).toEqual(["cut-ai-queue-other-a"]);
  });

  test("waiting rows with frame grabs past localStorage's room are kept in the thread store", async () => {
    const { threadStore, queues } = memoryStore();
    // A browser's localStorage: about 5 MB for the whole origin.
    const local = (globalThis as unknown as { localStorage: Storage }).localStorage;
    const setItem = local.setItem;
    local.setItem = (k: string, v: string) => {
      const used = [...store.entries()].reduce((n, [key, val]) => n + (key === k ? 0 : key.length + val.length), 0);
      if (used + k.length + v.length > 5_000_000) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      setItem(k, v);
    };
    useThreadStore(threadStore);
    await loadProjectThreads("p");
    const grab = (id: string) => ({ id, text: "use this frame", status: "queued", attachments: [{ scope: "file", id, kind: "image", url: `data:image/jpeg;base64,${"x".repeat(3_000_000)}` }] });
    expect(() => {
      writeQueuedRows("p", "a", [grab("r1")]);
      writeQueuedRows("p", "b", [grab("r2")]);
    }).not.toThrow();
    await flushThreadSaves();
    expect([...store.keys()].filter((k) => k.startsWith("cut-ai-queue-"))).toEqual([]);
    expect(Object.keys(queues.get("p") ?? {}).sort()).toEqual(["a", "b"]);
    // A reload reads them back.
    useThreadStore(threadStore);
    await loadProjectThreads("p");
    expect((readQueuedRows("p", "a") as { id: string }[]).map((m) => m.id)).toEqual(["r1"]);
    // An emptied queue clears its slot.
    writeQueuedRows("p", "a", []);
    await flushThreadSaves();
    expect(Object.keys(queues.get("p") ?? {})).toEqual(["b"]);
    expect(readQueuedRows("p", "a")).toEqual([]);
  });

  test("localStorage queues move to the store on first read, freeing the space", async () => {
    const { threadStore, lists, queues } = memoryStore();
    lists.set("p", [{ id: "a" }]);
    lists.set("p-2", [{ id: "c" }]);
    const row = (id: string) => ({ id, text: id, status: "queued", attachments: [] });
    store.set("cut-ai-queue-p-a", JSON.stringify([row("r1")]));
    store.set("cut-ai-queue-p-2-c", JSON.stringify([row("r2")]));
    // A queue whose project has no history in this browser waits in no thread.
    store.set("cut-ai-queue-gone-b", JSON.stringify([row("r3")]));
    store.set("cut-ai-model", "claude");
    useThreadStore(threadStore);
    await loadProjectThreads("p");
    expect((readQueuedRows("p", "a") as { id: string }[]).map((m) => m.id)).toEqual(["r1"]);
    // Every project's queue moves, each to the project whose id it names.
    expect(Object.keys(queues.get("p") ?? {})).toEqual(["a"]);
    expect(Object.keys(queues.get("p-2") ?? {})).toEqual(["c"]);
    expect([...store.keys()]).toEqual(["cut-ai-model"]);
  });

  test("a deleted project takes its waiting rows from the store", async () => {
    const { threadStore, queues } = memoryStore();
    useThreadStore(threadStore);
    await loadProjectThreads("p");
    writeProjectThreads("p", [{ id: "a", updatedAt: 1 }]);
    writeQueuedRows("p", "a", [{ id: "r", text: "t", status: "queued", attachments: [] }]);
    await flushThreadSaves();
    expect(queues.has("p")).toBe(true);
    clearProjectThreads("p");
    await flushThreadSaves();
    expect(queues.has("p")).toBe(false);
    expect(readQueuedRows("p", "a")).toEqual([]);
  });

  test("without a thread store, a full localStorage drops the waiting rows without throwing", () => {
    const local = (globalThis as unknown as { localStorage: Storage }).localStorage;
    local.setItem = () => { throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); };
    store.set("cut-ai-queue-p-a", JSON.stringify([{ id: "old" }]));
    expect(() => writeQueuedRows("p", "a", [{ id: "new" }])).not.toThrow();
    // The stale copy goes too: a reload never brings back rows that already ran.
    expect(readQueuedRows("p", "a")).toEqual([]);
  });

  test("threads of projects the listings no longer hold go once the project is confirmed gone", async () => {
    const { threadStore, lists } = memoryStore();
    lists.set("kept", [{ id: "a" }]);
    lists.set("elsewhere", [{ id: "b" }]);
    lists.set("deleted", [{ id: "c" }]);
    useThreadStore(threadStore);
    // The account listed all three once, which makes their threads its own.
    await sweepGoneProjectThreads(new Set(["kept", "elsewhere", "deleted"]), "me", async () => true);
    const asked: string[] = [];
    await sweepGoneProjectThreads(new Set(["kept"]), "me", async (id) => { asked.push(id); return id === "deleted"; });
    expect(asked.sort()).toEqual(["deleted", "elsewhere"]);
    expect([...lists.keys()].sort()).toEqual(["elsewhere", "kept"]);
    // Each project is asked about once per page.
    await sweepGoneProjectThreads(new Set(["kept"]), "me", async (id) => { asked.push(id); return false; });
    expect(asked).toHaveLength(2);
  });

  test("another account's threads survive this account's sweep", async () => {
    const { threadStore, lists } = memoryStore();
    lists.set("theirs", [{ id: "a" }]);
    lists.set("unlisted", [{ id: "b" }]);
    useThreadStore(threadStore);
    await sweepGoneProjectThreads(new Set(["theirs"]), "them", async () => true);
    // Every backend answers 404 for a project this account doesn't own, so a
    // miss proves nothing about a project it never listed.
    useThreadStore(threadStore);
    const asked: string[] = [];
    await sweepGoneProjectThreads(new Set(), "me", async (id) => { asked.push(id); return true; });
    expect(asked).toEqual([]);
    expect([...lists.keys()].sort()).toEqual(["theirs", "unlisted"]);
  });

  test("a full store keeps every other project's threads and says the save failed", async () => {
    const { threadStore, lists } = memoryStore(1_000_000);
    lists.set("old", [big("o1", 1, 300_000), big("o2", 5, 300_000)]);
    lists.set("older", [big("o0", 0, 300_000)]);
    useThreadStore(threadStore);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await loadProjectThreads("p");
      writeProjectThreads("p", [big("mine", 9, 200_000)]);
      await flushThreadSaves();
      expect(threadSaveFailure()?.message).toContain("storage is full");
      expect((lists.get("old") as { id: string }[]).map((t) => t.id)).toEqual(["o1", "o2"]);
      expect((lists.get("older") as { id: string }[]).map((t) => t.id)).toEqual(["o0"]);
      // The open chat is still on screen for the page to show.
      expect(readProjectThreads("p").map((t) => t.id)).toEqual(["mine"]);
    } finally {
      warn.mockRestore();
    }
  });

  test("a save that still fails is reported once, and clears when a save lands", async () => {
    const { threadStore } = memoryStore(1000);
    useThreadStore(threadStore);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let changes = 0;
    const stop = subscribeThreadSaveFailure(() => { changes++; });
    try {
      await loadProjectThreads("p");
      writeProjectThreads("p", [big("a", 1, 5000)]);
      await flushThreadSaves();
      writeProjectThreads("p", [big("a", 2, 6000)]);
      await flushThreadSaves();
      expect(threadSaveFailure()?.message).toContain("couldn't be saved");
      expect(warn.mock.calls).toHaveLength(1);
      expect(changes).toBe(1);
      // The live copy is still there for the page to show.
      expect(readProjectThreads("p")[0].updatedAt).toBe(2);
      writeProjectThreads("p", [{ id: "a", updatedAt: 3 }]);
      await flushThreadSaves();
      expect(threadSaveFailure()).toBeNull();
      expect(changes).toBe(2);
    } finally {
      stop();
      warn.mockRestore();
    }
  });
});
