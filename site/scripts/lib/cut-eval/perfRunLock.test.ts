import { expect, test } from "bun:test";
import { type AddressInfo } from "node:net";
import { lockPerfRun } from "./perfRunLock";

test("performance runs exclude each other and release their lock", async () => {
  const first = await lockPerfRun(0);
  const port = (first.address() as AddressInfo).port;
  try {
    await expect(lockPerfRun(port)).rejects.toThrow("Another performance run is active");
  } finally {
    await new Promise<void>((resolve) => first.close(() => resolve()));
  }
  const next = await lockPerfRun(port);
  await new Promise<void>((resolve) => next.close(() => resolve()));
});
