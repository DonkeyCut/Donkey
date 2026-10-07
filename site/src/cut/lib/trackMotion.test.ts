import { beforeEach, describe, expect, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";
import type { TrackSample } from "./trackKeys";
import type { MediaAsset, VideoClip } from "./types";

// The landmarkers need a browser; the stub reports a still square target and
// records which footage was read. `during` runs while the "read" is in flight.
const reads: string[] = [];
let during: () => void = () => {};
const still: TrackSample = {
  outline: [
    { x: 0.4, y: 0.4 },
    { x: 0.6, y: 0.4 },
    { x: 0.6, y: 0.6 },
    { x: 0.4, y: 0.6 },
  ],
  center: { x: 0.5, y: 0.5 },
  axis: [{ x: 0.4, y: 0.5 }, { x: 0.6, y: 0.5 }],
};
await stubModule<typeof import("./tracking")>("./tracking", import.meta.url, {
  trackFootage: async (src, _size, _target, times) => {
    reads.push(src);
    during();
    return times.map(() => still);
  },
});
const { trackMotion } = await import("./trackMotion");
const { useEditor } = await import("./store");

const video = (id: string, type: MediaAsset["type"] = "video"): MediaAsset => ({
  id,
  fileName: `${id}.mp4`,
  name: id,
  type,
  duration: 10,
  url: `blob:${id}`,
  width: 1920,
  height: 1080,
});
const clip = (o: Partial<VideoClip> & { id: string; assetId: string }): VideoClip => ({
  track: 0,
  start: 0,
  in: 0,
  out: 10,
  muted: false,
  ...o,
});

beforeEach(() => {
  reads.length = 0;
  during = () => {};
  useEditor.setState({
    assets: [video("shot"), video("pip"), video("logo", "image")],
    clips: [clip({ id: "base", assetId: "shot" }), clip({ id: "top", assetId: "pip", track: 1, start: 2, out: 4 })],
    overlays: [],
    aspect: "16:9",
  });
});

describe("the footage a track reads", () => {
  test("a clip follows the footage under it, never its own", async () => {
    await trackMotion({ id: "top", target: "head", use: "follow" });
    expect(reads).toEqual(["blob:shot"]);
  });

  test("a clip cannot be told to follow its own footage", async () => {
    await expect(trackMotion({ id: "top", target: "head", use: "follow", sourceId: "top" })).rejects.toThrow(/own footage/);
  });

  test("a mask on a video clip traces its own footage", async () => {
    await trackMotion({ id: "top", target: "head", use: "mask" });
    expect(reads).toEqual(["blob:pip"]);
  });

  test("a mask on an image clip traces the footage under it", async () => {
    useEditor.setState({ clips: [clip({ id: "base", assetId: "shot" }), clip({ id: "top", assetId: "logo", track: 1, start: 2, out: 2 })] });
    await trackMotion({ id: "top", target: "head", use: "mask" });
    expect(reads).toEqual(["blob:shot"]);
  });
});

describe("keys land on the item's clock", () => {
  test("moving the item during the read leaves the keys where the footage put them", async () => {
    during = () => useEditor.getState().updateClipTransient("top", { start: 3 });
    await trackMotion({ id: "top", target: "head", use: "mask", sourceId: "base" });
    const kf = useEditor.getState().clips.find((c) => c.id === "top")!.mask!.kf!;
    expect(kf[0].t).toBeCloseTo(0, 3);
  });
});
