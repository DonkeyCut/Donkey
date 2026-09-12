import { expect, spyOn, test } from "bun:test";
import { Chat } from "@ai-sdk/react";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { ChatRequests } from "./chatRequests";

test("a continuation and a queue dispatch cannot overlap SDK request cleanup", async () => {
  const streams: ReadableStreamDefaultController<UIMessageChunk>[] = [];
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const requests = new ChatRequests();
  const finished: string[] = [];
  const transport: ChatTransport<UIMessage> = {
    sendMessages: async () => new ReadableStream({ start(controller) { streams.push(controller); } }),
    reconnectToStream: async () => null,
  };
  const chat = new Chat({ transport, onFinish: ({ message }) => { finished.push(message.id); } });
  try {
    const first = requests.run(() => chat.sendMessage({ text: "Continue the interrupted edit." }));
    const duplicate = requests.run(() => chat.sendMessage({ text: "Continue the interrupted edit." }));
    await Promise.resolve();
    expect(streams).toHaveLength(1);
    expect(await duplicate).toBe(false);
    streams[0].enqueue({ type: "start", messageId: "reply" });
    streams[0].enqueue({ type: "finish" });
    streams[0].close();
    expect(await first).toBe(true);
    expect(finished).toEqual(["reply"]);
    expect(errors).not.toHaveBeenCalled();
    expect(requests.snapshot()).toBe(false);
  } finally {
    for (const stream of streams) { try { stream.close(); } catch {} }
    errors.mockRestore();
  }
});

test("reconnect holds the request while the SDK still reports ready", async () => {
  const requests = new ChatRequests();
  let finish!: () => void;
  const states: boolean[] = [];
  const unsubscribe = requests.subscribe(() => states.push(requests.snapshot()));
  const reconnect = requests.run(() => new Promise<void>((resolve) => { finish = resolve; }));
  expect(await requests.run(async () => { throw new Error("Duplicate request"); })).toBe(false);
  finish();
  await reconnect;
  expect(await requests.run(async () => {})).toBe(true);
  expect(states).toEqual([true, false, true, false]);
  unsubscribe();
});

test("a failed request releases the thread and preserves its error", async () => {
  const requests = new ChatRequests();
  const failure = new Error("Transport unavailable");
  await expect(requests.run(async () => { throw failure; })).rejects.toBe(failure);
  expect(requests.snapshot()).toBe(false);
  expect(await requests.run(async () => {})).toBe(true);
});
