import { afterEach, expect, test } from "bun:test";
import {
  clearStorageQuotaWall,
  emitImportWall,
  emitStorageQuota,
  onStorageQuota,
  openStorageUpgrade,
  startImportWall,
  type StorageQuotaDetail,
} from "./storageQuota";

const offs: (() => void)[] = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
  clearStorageQuotaWall();
  startImportWall();
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

test("a drop meets the wall once, however many of its uploads are refused", () => {
  const seen = listen();
  startImportWall();
  emitImportWall({ source: "import", needBytes: 300 });
  clearStorageQuotaWall();
  emitImportWall({ source: "quota-413" });
  emitImportWall({ source: "quota-413" });
  expect(seen.map((d) => d.source)).toEqual(["import"]);
});

test("the next drop meets the wall again", () => {
  const seen = listen();
  startImportWall();
  emitImportWall({ source: "quota-413" });
  clearStorageQuotaWall();
  startImportWall();
  emitImportWall({ source: "quota-413" });
  expect(seen).toHaveLength(2);
});

test("a drop refused while another wall stands stays quiet once that one closes", () => {
  const seen = listen();
  startImportWall();
  emitStorageQuota({ source: "pill" });
  emitImportWall({ source: "quota-413" });
  clearStorageQuotaWall();
  emitImportWall({ source: "quota-413" });
  expect(seen.map((d) => d.source)).toEqual(["pill"]);
});
