import { expect, test } from "bun:test";
import { footageSlots } from "./templateFill";
import type { MediaAsset, VideoClip } from "./types";

const asset = (id: string, type: MediaAsset["type"]) => ({ id, type }) as MediaAsset;
const clip = (id: string, assetId: string, start: number, track: number) =>
  ({ id, assetId, start, track, in: 0, out: 2 }) as VideoClip;

test("footage slots run in play order, lower track first at a tie, skipping sound", () => {
  const assets = [asset("v", "video"), asset("i", "image"), asset("a", "audio")];
  const clips = [clip("late", "v", 4, 0), clip("top", "i", 0, 1), clip("base", "v", 0, 0), clip("snd", "a", 1, 0)];
  expect(footageSlots(clips, assets).map((c) => c.id)).toEqual(["base", "top", "late"]);
});
