import { afterEach, expect, test } from "bun:test";
import {
  clearStorageQuotaWall,
  emitStorageQuota,
  onStorageQuota,
  openStorageUpgrade,
  type StorageQuotaDetail,
} from "./storageQuota";

const offs: (() => void)[] = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
  clearStorageQuotaWall();
});

function listen() {
  const seen: StorageQuotaDetail[] = [];
  offs.push(onStorageQuota((detail) => seen.push(detail)));
  return seen;
}

test("the wall goes up once, and says whether it landed", () => {
  const seen = listen();
  expect(emitStorageQuota({ source: "render" })).toBe(true);
  expect(emitStorageQuota({ source: "quota-413" })).toBe(false);
  expect(seen).toEqual([{ source: "render" }]);
});

test("with nothing mounted to show it, nobody was told", () => {
  expect(emitStorageQuota({ source: "render" })).toBe(false);
  const seen = listen();
  expect(emitStorageQuota({ source: "render" })).toBe(true);
  expect(seen).toHaveLength(1);
});

test("a deliberate click opens past a standing wall", () => {
  const seen = listen();
  emitStorageQuota({ source: "render" });
  openStorageUpgrade({ source: "pill" });
  expect(seen.map((d) => d.source)).toEqual(["render", "pill"]);
});
