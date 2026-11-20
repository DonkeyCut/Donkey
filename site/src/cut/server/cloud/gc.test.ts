import { expect, test } from "bun:test";
import { proxyNamesIn, videosWithoutCards } from "./gc";

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

test("the card backfill picks shared videos with no stored still, owned by the sharer", () => {
  const video = { type: "video" };
  const assets = [
    { id: "a", userId: "u", meta: video },
    { id: "b", userId: "u", meta: video },
    { id: "c", userId: "u", meta: { type: "audio" } },
    { id: "d", userId: "other", meta: video },
  ];
  const shares = ["a", "b", "c", "d"].map((targetId) => ({ userId: "u", targetId }));
  const picked = videosWithoutCards(shares, assets, new Set(["cut/u/library-cards/b.jpg"]));
  expect(picked.map((a) => a.id)).toEqual(["a"]);
});
