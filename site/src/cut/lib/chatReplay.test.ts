import { expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import { replayChatStream } from "./chatReplay";

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
