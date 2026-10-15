import { beforeEach, describe, expect, test } from "bun:test";
import { Chat } from "@ai-sdk/react";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";

import {
  chatThreadDeleted,
  deleteStoredThread,
  clearProjectThreads,
  mergeThreads,
  readProjectThreads,
  readThreadIds,
  recordThread,
  threadsKey,
  writeProjectThreads,
  writeRawThreads,
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
