import { expect, test } from "bun:test";
import { proxyNamesIn } from "./gc";

test("a stored document names the proxies its assets carry, and nothing else", () => {
  const names = proxyNamesIn({
    assets: [
      { fileName: "IMG_1.MOV", proxy: { fileName: "IMG_1.proxy.mp4", sizeBytes: 5 } },
      { fileName: "b.mp4" },
      { fileName: "c.MOV", proxy: {} },
    ],
  });
  expect([...names]).toEqual(["IMG_1.proxy.mp4"]);
  expect(proxyNamesIn(null).size).toBe(0);
  expect(proxyNamesIn({}).size).toBe(0);
});
