import { EventEmitter } from "node:events";
import { expect, mock, test } from "bun:test";

/** Local dev queued cloud jobs nothing ever claimed: the dev server had no
 * container to wake and no worker of its own, so the page polled forever. A
 * wake in dev starts one worker, and starts another once that one exits. */

const spawned: EventEmitter[] = [];
mock.module("node:child_process", () => ({
  spawn: () => {
    const child = new EventEmitter();
    spawned.push(child);
    return child;
  },
}));
const { startDevWorker } = await import("./devWorker");

test("a wake starts one worker and another once it exits", () => {
  startDevWorker();
  startDevWorker();
  expect(spawned).toHaveLength(1);

  spawned[0].emit("exit", 0);
  startDevWorker();
  expect(spawned).toHaveLength(2);
});
