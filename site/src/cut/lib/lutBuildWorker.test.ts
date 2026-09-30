import { expect, test } from "bun:test";
import type { ParsedLut } from "@donkeycut/effects-kit";
import { allowance, memoryUsage } from "./memoryBudget";
import { noteWorkerTables, tableMessage, workerTableBytes } from "./lutBuild";
import { TableCache } from "./lutBuild.worker";

const table = (floats: number): ParsedLut => ({
  cube: { size: 2, data: new Float32Array(floats), min: [0, 0, 0], max: [1, 1, 1] },
});

test("the worker's library LUTs are bounded in bytes, least recently used out first", () => {
  const cache = new TableCache(1000);
  expect(cache.keep("a", table(100))).toEqual([]); // 400 bytes
  expect(cache.keep("b", table(100))).toEqual([]);
  expect(cache.take("a")).toBeDefined(); // a is now the newest
  expect(cache.keep("c", table(100))).toEqual(["b"]);
  expect(cache.bytes).toBeLessThanOrEqual(1000);
  expect(cache.take("b")).toBeUndefined();
  expect(cache.take("a")).toBeDefined();
  expect(cache.take("c")).toBeDefined();
});

test("two large tables used in turn are both kept, so neither is sent again per build", () => {
  // Each is past the cap on its own. Keeping only the newest would drop one
  // and re-receive it on every build that alternates between them.
  const cache = new TableCache(1000);
  cache.keep("big1", table(1000));
  expect(cache.keep("big2", table(1000))).toEqual([]);
  for (let i = 0; i < 4; i++) {
    expect(cache.take("big1")).toBeDefined();
    expect(cache.take("big2")).toBeDefined();
  }
  // A third makes the oldest go.
  cache.take("big1");
  expect(cache.keep("big3", table(1000))).toEqual(["big2"]);
  expect(cache.bytes).toBe(8000);
});

test("a smaller cap from the page sheds down to it", () => {
  const cache = new TableCache(10_000);
  cache.keep("a", table(100));
  cache.keep("b", table(100));
  cache.keep("c", table(100));
  expect(cache.setCap(800)).toEqual(["a"]);
  expect(cache.bytes).toBe(800);
});

test("the worker's tables count in the page's memory budget", () => {
  const before = memoryUsage().pictures;
  noteWorkerTables({ bytes: 5_000_000, evicted: [] });
  expect(workerTableBytes()).toBe(5_000_000);
  expect(memoryUsage().pictures - before).toBe(5_000_000);
  noteWorkerTables({ bytes: 0, evicted: ["lut:x"] });
  expect(memoryUsage().pictures).toBe(before);
});

test("a table goes to the worker as a transferred copy under the budget's cap", () => {
  const lut: ParsedLut = {
    shaper: { size: 2, data: new Float32Array([0, 0, 0, 1, 1, 1]), min: [0, 0, 0], max: [1, 1, 1] },
    ...table(24),
  };
  const { msg, transfer } = tableMessage("lut:x", lut);
  expect(msg.cap).toBe(allowance("lutWorkerTables", 48 * 2 ** 20));
  // The page keeps its own table; the worker gets its own buffers, moved.
  expect(transfer).toEqual([msg.lut.shaper!.data.buffer, msg.lut.cube!.data.buffer] as ArrayBuffer[]);
  expect(msg.lut.cube!.data).not.toBe(lut.cube!.data);
  expect(Array.from(msg.lut.cube!.data)).toEqual(Array.from(lut.cube!.data));
  const clone = structuredClone(msg, { transfer });
  expect(clone.lut.cube!.data.length).toBe(24);
  // Transferred away from the message, the page's own table untouched.
  expect(msg.lut.cube!.data.length).toBe(0);
  expect(lut.cube!.data.length).toBe(24);
});
