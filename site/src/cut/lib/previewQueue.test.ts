import { expect, test } from "bun:test";
import { createPreviewQueue } from "./previewQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("closing during a render drains the latest edit and coalesces intermediate edits", async () => {
  const first = deferred<string>();
  const calls: number[] = [];
  const queue = createPreviewQueue(async (input: number) => {
    calls.push(input);
    return input === 1 ? first.promise : String(input);
  }, 60_000);
  queue.stage(1);
  const running = queue.flush();
  queue.stage(2);
  queue.stage(3);
  const closing = queue.flush(true);
  first.resolve("1");
  await Promise.all([running, closing]);
  expect(calls).toEqual([1, 3]);
  expect(queue.getState()).toEqual({ status: "done", result: "3" });
});

test("an old completion cannot replace the queued revision's state", async () => {
  const first = deferred<string>();
  const queue = createPreviewQueue(() => first.promise, 60_000);
  queue.stage(1);
  const running = queue.flush();
  queue.stage(2);
  first.resolve("old");
  await running;
  expect(queue.getState()).toEqual({ status: "queued" });
});

test("a failed render exposes its error and releases the queue for the next revision", async () => {
  const error = new Error("render failed");
  const queue = createPreviewQueue(async (input: number) => {
    if (input === 1) throw error;
    return input;
  }, 60_000);
  queue.stage(1);
  await queue.flush();
  expect(queue.getState()).toEqual({ status: "error", error });
  queue.stage(2);
  await queue.flush(true);
  expect(queue.getState()).toEqual({ status: "done", result: 2 });
});
