import { expect, test } from "bun:test";
import { patchIsNoop, useEditor } from "./store";
import type { MediaAsset } from "./types";

const COLOR = { matrix: "bt709", fullRange: false, bitDepth: 8, detected: "rec709", codec: "avc1" } as const;
const asset: MediaAsset = {
  id: "a",
  fileName: "a.mp4",
  name: "a",
  type: "video",
  duration: 4,
  width: 3840,
  height: 2160,
  url: "https://media.test/a.mp4",
  color: { ...COLOR },
};

test("a patch that restates the asset changes nothing", () => {
  expect(patchIsNoop(asset, { width: 3840, height: 2160, color: { ...COLOR } })).toBe(true);
  expect(patchIsNoop(asset, { color: { ...COLOR, fullRange: true } })).toBe(false);
  expect(patchIsNoop(asset, { width: 1920 })).toBe(false);
  // Lists are new pictures whenever they are new arrays.
  expect(patchIsNoop({ ...asset, thumbs: ["x"] }, { thumbs: ["x"] })).toBe(false);
});

test("an asset write that changes nothing wakes nobody", () => {
  useEditor.setState({ assets: [asset], readOnly: false });
  let writes = 0;
  const stop = useEditor.subscribe(() => writes++);
  try {
    // Two probes of the same file land the same answer: one write at most.
    useEditor.getState().updateAsset("a", { width: 3840, height: 2160, color: { ...COLOR } });
    expect(writes).toBe(0);
    useEditor.getState().updateAsset("a", { color: { ...COLOR, detected: "srgb" } });
    expect(writes).toBe(1);
  } finally {
    stop();
  }
});

test("a probe write that leaves the picture alone waits for the play to stop", async () => {
  const { landProbedFacts } = await import("./media");
  const bare = { ...asset, id: "b", color: undefined };
  useEditor.setState({ assets: [bare], readOnly: false, playing: true });
  // A Rec.709 record draws what the unprobed asset already draws.
  const landed = landProbedFacts("b", { width: 3840, height: 2160, color: { ...COLOR } });
  await new Promise((r) => setTimeout(r, 10));
  expect(useEditor.getState().assets[0].color).toBeUndefined();
  useEditor.setState({ playing: false });
  await landed;
  expect(useEditor.getState().assets[0].color).toEqual({ ...COLOR });
});

test("a probe write that changes the picture lands mid-play", async () => {
  const { landProbedFacts } = await import("./media");
  const bare = { ...asset, id: "c", color: undefined };
  useEditor.setState({ assets: [bare], readOnly: false, playing: true });
  const hlg = { matrix: "bt2020nc", fullRange: false, bitDepth: 10, detected: "hlg", codec: "hvc1" } as const;
  await landProbedFacts("c", { color: { ...hlg } });
  expect(useEditor.getState().assets[0].color).toEqual({ ...hlg });
  useEditor.setState({ playing: false });
});

test("a profile override set while a probe write waits for the play survives it", async () => {
  const { landProbedFacts } = await import("./media");
  const bare = { ...asset, id: "d", color: undefined };
  useEditor.setState({ assets: [bare], readOnly: false, playing: true });
  const landed = landProbedFacts("d", { width: 3840, height: 2160, color: { ...COLOR } });
  await new Promise((r) => setTimeout(r, 10));
  useEditor.getState().setAssetColorProfile("d", "apple-log-2");
  useEditor.setState({ playing: false });
  await landed;
  expect(useEditor.getState().assets[0].color).toEqual({ ...COLOR });
  expect(useEditor.getState().assets[0].colorProfile).toBe("apple-log-2");
});

test("a slow import probe lands under the profile the person set first", async () => {
  const { landProbedFacts } = await import("./media");
  const bare = { ...asset, id: "e", color: undefined };
  useEditor.setState({ assets: [bare], readOnly: false, playing: true });
  // Set on the asset before the header walk came back, as an importRemote or
  // registerLandedAsset probe does behind the placement.
  useEditor.getState().setAssetColorProfile("e", "apple-log");
  const hlg = { matrix: "bt2020nc", fullRange: false, bitDepth: 10, detected: "hlg", codec: "hvc1" } as const;
  await landProbedFacts("e", { color: { ...hlg } });
  expect(useEditor.getState().assets[0].color).toEqual({ ...hlg });
  expect(useEditor.getState().assets[0].colorProfile).toBe("apple-log");
  useEditor.setState({ playing: false });
});

test("whether a probe changes the picture is read with the override in place", async () => {
  const { probeChangesPicture } = await import("./media");
  const overridden: MediaAsset = { ...asset, color: { ...COLOR }, colorProfile: "apple-log-2" };
  // The header's profile guess changes nothing the override already decides.
  expect(probeChangesPicture(overridden, { color: { ...COLOR, detected: "hlg" } })).toBe(false);
  expect(probeChangesPicture(overridden, { color: { ...COLOR, fullRange: true } })).toBe(true);
});

test("a profile override on media never read leaves the header facts to the probe, and undo restores the asset exactly", async () => {
  const { landProbedFacts } = await import("./media");
  const { lacksColor } = await import("./colorProbe");
  const { sourceProfileOf } = await import("./sourceColor");
  const bare: MediaAsset = { ...asset, id: "f" };
  delete bare.color;
  useEditor.setState({ assets: [bare], readOnly: false, playing: false });
  useEditor.getState().setAssetColorProfile("f", "apple-log");
  const set = useEditor.getState().assets[0];
  expect(set.color).toBeUndefined();
  expect(set.colorProfile).toBe("apple-log");
  // The override is no header fact: the header read still runs.
  expect(lacksColor(set)).toBe(true);
  useEditor.getState().undo();
  expect(useEditor.getState().assets[0]).toEqual(bare);
  useEditor.getState().redo();
  const hlg = { matrix: "bt2020nc", fullRange: false, bitDepth: 10, detected: "hlg", codec: "hvc1" } as const;
  await landProbedFacts("f", { color: { ...hlg } });
  const probed = useEditor.getState().assets[0];
  expect(probed.color).toEqual({ ...hlg });
  expect(sourceProfileOf(probed)).toBe("apple-log");
  useEditor.getState().undo();
  expect(useEditor.getState().assets[0]).toEqual({ ...bare, color: { ...hlg } });
});

test("a project saved with the override inside the header record loads it beside the record", async () => {
  const { liftColorProfile, storedAssets } = await import("./store");
  const old = { ...asset, color: { ...COLOR, profile: "hlg" } } as MediaAsset;
  const lifted = liftColorProfile(old);
  expect(lifted.color).toEqual({ ...COLOR });
  expect(lifted.colorProfile).toBe("hlg");
  expect(storedAssets([lifted])[0]).toMatchObject({ color: { ...COLOR }, colorProfile: "hlg" });
  expect(liftColorProfile(asset)).toBe(asset);
});
