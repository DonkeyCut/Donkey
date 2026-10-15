import { expect, test } from "bun:test";
import { Chat } from "@ai-sdk/react";
import type { UIMessage, UIMessageChunk } from "ai";
import { countChunks, replayChatStream } from "./chatReplay";
import { journalAhead, type JournalMark } from "./chatResume";

test("replay identifies the saved reply before exposing any chunks", async () => {
  let prepared = false;
  const source = new ReadableStream<UIMessageChunk>({ start(controller) {
    controller.enqueue({ type: "start", messageId: "reply", messageMetadata: { requestMessageId: "ask" } });
    controller.enqueue({ type: "finish" });
    controller.close();
  } });
  const replay = await replayChatStream(source, (id, request) => {
    expect(id).toBe("reply");
    expect(request).toBe("ask");
    prepared = true;
    return true;
  }, () => {});
  expect(prepared).toBe(true);
  const reader = replay!.getReader();
  expect((await reader.read()).value?.type).toBe("start");
  expect((await reader.read()).value?.type).toBe("finish");
  expect((await reader.read()).done).toBe(true);
  expect(source.locked).toBe(false);
});

test("a stale journal cancels its reader without replaying another turn", async () => {
  let cancelled = false;
  const source = new ReadableStream<UIMessageChunk>({
    start(controller) { controller.enqueue({ type: "start", messageId: "old" }); },
    cancel() { cancelled = true; },
  });
  expect(await replayChatStream(source, () => false, () => {})).toBe(null);
  expect(cancelled).toBe(true);
  expect(source.locked).toBe(false);
});

test("unmount closes a replay even while it is waiting for the next event", async () => {
  let close!: () => void;
  let cancelled = false;
  const source = new ReadableStream<UIMessageChunk>({
    start(controller) { controller.enqueue({ type: "start", messageId: "reply" }); },
    cancel() { cancelled = true; },
  });
  const replay = await replayChatStream(source, () => true, (fn) => { close = fn; });
  const reader = replay!.getReader();
  await reader.read();
  const waiting = reader.read();
  close();
  expect((await waiting).done).toBe(true);
  expect(cancelled).toBe(true);
});


test("a saved completed reply is never cleared or replayed on reopen", async () => {
  let cancelled = false;
  const source = new ReadableStream<UIMessageChunk>({
    start(controller) { controller.enqueue({ type: "start", messageId: "complete" }); },
    cancel() { cancelled = true; },
  });
  const replay = await replayChatStream(source, () => {
    throw new Error("A completed reply must keep its saved parts");
  }, () => {}, "complete");
  expect(replay).toBe(null);
  expect(cancelled).toBe(true);
});

test("a new reply resumes after the previous reply was completed", async () => {
  const source = new ReadableStream<UIMessageChunk>({ start(controller) {
    controller.enqueue({ type: "start", messageId: "new" });
    controller.enqueue({ type: "finish" });
    controller.close();
  } });
  const replay = await replayChatStream(source, () => true, () => {}, "previous");
  expect(replay).not.toBe(null);
  await replay!.cancel();
});

test("a stream's chunks are counted under its turn", async () => {
  const marks: { messageId: string; chunks: number }[] = [];
  const source = new ReadableStream<UIMessageChunk>({ start(controller) {
    controller.enqueue({ type: "start", messageId: "turn-1" });
    controller.enqueue({ type: "text-start", id: "t" });
    controller.enqueue({ type: "finish" });
    controller.close();
  } });
  const reader = countChunks(source, (mark) => marks.push(mark)).getReader();
  while (!(await reader.read()).done);
  expect(marks.at(-1)).toEqual({ messageId: "turn-1", chunks: 3 });
});

// The engine kept the whole turn in its journal while the page's saved copy
// stopped at call 71 and was stamped complete. Opening the thread replays the
// journal over that copy, and the thread then counts the whole journal.
test("a completed thread saved short of its journal catches up by replaying it", async () => {
  const journal: UIMessageChunk[] = [
    { type: "start", messageId: "turn-1", messageMetadata: { requestMessageId: "ask" } },
    ...Array.from({ length: 296 }, (_, i): UIMessageChunk[] => [
      { type: "tool-input-available", toolCallId: `call-${i}`, toolName: "add_title", input: { text: `CLIP ${i}` } },
      { type: "tool-output-available", toolCallId: `call-${i}`, output: { id: `title-${i}` } },
    ]).flat(),
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: "FINAL: every title is in." },
    { type: "text-end", id: "t" },
    { type: "finish" },
  ];
  const saved: UIMessage[] = [
    { id: "ask", role: "user", parts: [{ type: "text", text: "build the titles" }] },
    { id: "turn-1", role: "assistant", parts: journal.slice(1, 143).flatMap((chunk) => chunk.type === "tool-output-available"
      ? [{ type: "tool-add_title", toolCallId: chunk.toolCallId, state: "output-available", input: {}, output: chunk.output } as unknown as UIMessage["parts"][number]]
      : []) },
  ];
  expect(saved[1].parts).toHaveLength(71);
  const peeked = { messageId: "turn-1", chunks: journal.length };
  expect(journalAhead(saved, undefined, peeked)).toBe(true);
  let mark: JournalMark | null = null;
  let toolCalls = 0;
  const chat = new Chat<UIMessage>({
    id: "thread",
    messages: saved,
    // The replay hands every call to onToolCall again; the panel lets them
    // pass, since a finished turn's tools already ran.
    onToolCall: () => { toolCalls++; },
    transport: {
      sendMessages: async () => { throw new Error("A catch-up sends nothing."); },
      reconnectToStream: async () => {
        const source = new ReadableStream<UIMessageChunk>({ start(controller) {
          for (const chunk of journal) controller.enqueue(chunk);
          controller.close();
        } });
        const replay = await replayChatStream(source, (id) => {
          chat.messages = chat.messages.map((m) => m.id === id ? { ...m, parts: [] } : m);
          return true;
        }, () => {});
        return replay && countChunks(replay, (next) => { mark = next; });
      },
    },
  });
  await chat.resumeStream();
  const reply = chat.messages.at(-1)!;
  expect(chat.messages.map((m) => m.id)).toEqual(["ask", "turn-1"]);
  expect(reply.parts.filter((p) => p.type.startsWith("tool-"))).toHaveLength(296);
  expect(reply.parts.at(-1)).toMatchObject({ type: "text", text: "FINAL: every title is in." });
  expect(toolCalls).toBe(296);
  expect(journalAhead(chat.messages, mark ?? undefined, peeked)).toBe(false);
});
