import { expect, test } from "bun:test";
import { warmOrder } from "./spanWarm";

// A cut that changes file every half second stalls at every cold join, so the
// clips still to play are read first, each from the file the preview decodes.
const assets = [
  { id: "a", type: "video" as const, url: "https://m/a.mp4" },
  { id: "b", type: "video" as const, url: "https://m/b.mp4", proxyUrl: "https://m/b.mp4.light.mp4" },
  { id: "s", type: "image" as const, url: "https://m/s.png" },
];
const clips = [
  { assetId: "a", start: 1, in: 4, out: 4.5 },
  { assetId: "b", start: 0.5, in: 10, out: 10.5 },
  { assetId: "a", start: 0, in: 0, out: 0.5 },
  { assetId: "s", start: 1.5, in: 0, out: 1 },
];

test("clips read in timeline order, from the proxy where the preview plays one", () => {
  expect(warmOrder(clips, assets, 0)).toEqual([
    { url: "https://m/a.mp4", from: 0, to: 0.5 },
    { url: "https://m/b.mp4.light.mp4", from: 10, to: 10.5 },
    { url: "https://m/a.mp4", from: 4, to: 4.5 },
  ]);
});

test("what plays from the playhead goes first, the clip under it included, then the top", () => {
  expect(warmOrder(clips, assets, 0.7).map((s) => s.from)).toEqual([10, 4, 0]);
});

test("a reversed or sped-up clip reads its source span", () => {
  const [span] = warmOrder([{ assetId: "a", start: 0, in: 6, out: 2, speed: 4 }], assets, 0);
  expect(span).toEqual({ url: "https://m/a.mp4", from: 2, to: 6 });
});
