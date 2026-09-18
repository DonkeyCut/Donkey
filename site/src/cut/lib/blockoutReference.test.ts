import { beforeEach, expect, test } from "bun:test";
import { runAiTool } from "./aiTools";
import { storedAssets, useEditor } from "./store";

// A cut blocked out from a reference must not end up playing that reference.
// The mark rides the asset, so the refusal holds for every tool that places
// media, whatever the model was reaching for when it tried.

beforeEach(() => {
  useEditor.setState({
    clips: [],
    overlays: [],
    transitions: [],
    audioClips: [],
    assets: [
      { id: "ref", fileName: "ref.mp4", name: "Reference", type: "video", duration: 60, url: "", reference: true },
      { id: "mine", fileName: "mine.mp4", name: "My shot", type: "video", duration: 12, url: "" },
      { id: "still", fileName: "ref.png", name: "Reference still", type: "image", duration: 0, url: "", reference: true },
    ],
  });
});

const message = async (p: Promise<unknown>) =>
  p.then(() => "", (e: unknown) => (e instanceof Error ? e.message : String(e)));

test("the assistant cannot put the reference in the cut it is copied from", async () => {
  const error = await message(runAiTool("add_clip", { asset_id: "ref" }));
  expect(error).toContain("reference this cut is blocked out from");
  expect(useEditor.getState().clips).toHaveLength(0);
});

test("the reference cannot fill a block either", async () => {
  await runAiTool("add_clip", { asset_id: "mine", start: 0 });
  const clip = useEditor.getState().clips[0]!;
  const error = await message(runAiTool("replace_item", { id: clip.id, asset_id: "ref" }));
  expect(error).toContain("reference this cut is blocked out from");
  expect(useEditor.getState().clips[0]!.assetId).toBe("mine");
});

test("the person's own footage still goes down", async () => {
  await runAiTool("add_clip", { asset_id: "mine", start: 0 });
  expect(useEditor.getState().clips.map((c) => c.assetId)).toEqual(["mine"]);
});

test("an unmarked source is nobody's reference", async () => {
  useEditor.getState().updateAsset("ref", { reference: undefined });
  await runAiTool("add_clip", { asset_id: "ref", start: 0 });
  expect(useEditor.getState().clips.map((c) => c.assetId)).toEqual(["ref"]);
});

test("a run of blocks lays a cut out end to end, storing nothing", async () => {
  useEditor.getState().updateAsset("ref", { reference: undefined });
  const out = (await runAiTool("add_clip", {
    blocks: [
      { seconds: 4, label: "wide of the kitchen" },
      { seconds: 2.5, label: "hands only" },
      { seconds: 6 },
    ],
    reference_asset_id: "ref",
  })) as { placed: { start: number; seconds: number; label: string }[] };

  expect(out.placed.map((p) => [p.start, p.seconds])).toEqual([[0, 4], [4, 2.5], [6.5, 6]]);
  expect(out.placed[2]!.label).toBe("Shot 3");
  const state = useEditor.getState();
  // Each block is an ordinary clip on track 0, and no two intersect.
  const blocks = state.clips.filter((c) => c.track === 0).sort((a, b) => a.start - b.start);
  expect(blocks).toHaveLength(3);
  for (let i = 1; i < blocks.length; i++)
    expect(blocks[i]!.start).toBeGreaterThanOrEqual(blocks[i - 1]!.start + (blocks[i - 1]!.out - blocks[i - 1]!.in));
  // The sources draw themselves: no file, no url, nothing uploaded.
  const made = state.assets.filter((a) => a.block !== undefined);
  expect(made).toHaveLength(3);
  expect(made.every((a) => a.url === "" && a.fileName === "")).toBe(true);
  // Naming the source makes it the reference, so the tools stop placing it.
  expect(state.assets.find((a) => a.id === "ref")!.reference).toBe(true);
});

test("the whole blockout is one undo step", async () => {
  useEditor.getState().updateAsset("ref", { reference: undefined });
  await runAiTool("add_clip", {
    blocks: [{ seconds: 3 }, { seconds: 3 }, { seconds: 3 }],
  });
  expect(useEditor.getState().clips).toHaveLength(3);
  useEditor.getState().undo();
  expect(useEditor.getState().clips).toHaveLength(0);
});

test("footage takes a block's place and its length", async () => {
  await runAiTool("add_clip", { blocks: [{ seconds: 5, label: "the shot" }] });
  const block = useEditor.getState().clips[0]!;
  await runAiTool("replace_item", { id: block.id, asset_id: "mine" });
  const filled = useEditor.getState().clips[0]!;
  expect(filled.assetId).toBe("mine");
  expect(filled.start).toBe(block.start);
  expect(filled.out - filled.in).toBe(5);
  // The block it replaced is gone with it.
  expect(useEditor.getState().assets.some((a) => a.block !== undefined)).toBe(false);
});

test("a blockout survives the save", () => {
  useEditor.getState().updateAsset("ref", { reference: true });
  useEditor.setState({
    assets: [
      ...useEditor.getState().assets,
      {
        id: "b1",
        fileName: "",
        name: "wide of the kitchen",
        type: "image",
        duration: 4,
        url: "",
        block: { label: "wide of the kitchen" },
        origin: "block",
      },
    ],
  });
  const saved = storedAssets(useEditor.getState().assets);
  // Without these two the blockout comes back as an image with no file: the
  // shot draws nothing, footage dropped on it inserts beside it instead of
  // filling it, and the reference is placeable again.
  expect(saved.find((a) => a.id === "b1")?.block).toEqual({ label: "wide of the kitchen" });
  expect(saved.find((a) => a.id === "ref")?.reference).toBe(true);
});

test("the reference is refused on every door, not just track 0", async () => {
  for (const call of [
    runAiTool("add_overlay_video", { asset_id: "ref", track: 1 }),
    runAiTool("add_sticker", { asset_id: "still" }),
  ]) {
    expect(await message(call)).toContain("reference this cut is blocked out from");
  }
  expect(useEditor.getState().clips).toHaveLength(0);
  expect(useEditor.getState().overlays).toHaveLength(0);
});

test("a swap drops coverage painted for the source it replaces", async () => {
  await runAiTool("add_clip", { asset_id: "mine", start: 0 });
  const clip = useEditor.getState().clips[0]!;
  useEditor.getState().updateClip(clip.id, { mask: { kind: "rect", x: 0, y: 0, w: 0.5, h: 0.5 } });
  useEditor.getState().updateAsset("ref", { reference: undefined });
  await runAiTool("replace_item", { id: clip.id, asset_id: "ref" });
  expect(useEditor.getState().clips[0]!.mask).toBeUndefined();
});

test("a clip never plays past the end of a shorter source", async () => {
  await runAiTool("add_clip", { blocks: [{ seconds: 20, label: "long shot" }] });
  const block = useEditor.getState().clips[0]!;
  await runAiTool("replace_item", { id: block.id, asset_id: "mine" });
  const filled = useEditor.getState().clips[0]!;
  expect(filled.out).toBeLessThanOrEqual(12);
});

test("a sticker's swap carries how it plays", async () => {
  useEditor.setState({
    assets: [
      { id: "anim", fileName: "wave.json", name: "Wave", type: "image", duration: 0, url: "" },
      { id: "flat", fileName: "star.png", name: "Star", type: "image", duration: 0, url: "" },
    ],
    overlays: [],
  });
  await runAiTool("add_sticker", { asset_id: "anim" });
  const sticker = useEditor.getState().overlays[0]!;
  expect((sticker as { lottie?: boolean }).lottie).toBe(true);

  // A still does not animate: left set, the export plays a PNG through the
  // animation renderer.
  await runAiTool("replace_item", { id: sticker.id, asset_id: "flat" });
  expect((useEditor.getState().overlays[0] as { lottie?: boolean }).lottie).toBeUndefined();

  await runAiTool("replace_item", { id: sticker.id, asset_id: "anim" });
  expect((useEditor.getState().overlays[0] as { lottie?: boolean }).lottie).toBe(true);
});
