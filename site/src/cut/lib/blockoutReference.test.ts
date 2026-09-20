import { beforeEach, expect, test } from "bun:test";
import { runAiTool } from "./aiTools";
import { storedAssets, useEditor } from "./store";

// Blocks hold a watched video's shots until footage arrives. What fills them
// is the ask's to decide — the person's own footage, or the source the cut was
// blocked out from — so no tool here refuses a source.

beforeEach(() => {
  useEditor.setState({
    clips: [],
    overlays: [],
    transitions: [],
    audioClips: [],
    assets: [
      { id: "ref", fileName: "ref.mp4", name: "Reference", type: "video", duration: 60, url: "" },
      { id: "mine", fileName: "mine.mp4", name: "My shot", type: "video", duration: 12, url: "" },
      { id: "still", fileName: "ref.png", name: "Reference still", type: "image", duration: 0, url: "" },
    ],
  });
});

test("the person's own footage still goes down", async () => {
  await runAiTool("add_clip", { asset_id: "mine", start: 0 });
  expect(useEditor.getState().clips.map((c) => c.assetId)).toEqual(["mine"]);
});

test("the watched source can play in the cut blocked out from it", async () => {
  await runAiTool("add_clip", { blocks: [{ seconds: 4 }, { seconds: 3 }] });
  const [first, second] = useEditor.getState().clips;
  await runAiTool("replace_item", { id: first!.id, asset_id: "ref" });
  await runAiTool("replace_item", { id: second!.id, asset_id: "mine" });
  expect(useEditor.getState().clips.map((c) => c.assetId)).toEqual(["ref", "mine"]);
});

test("spans cut a source at its own shot boundaries", async () => {
  const out = (await runAiTool("add_clip", {
    asset_id: "ref",
    spans: [{ from: 0, to: 4 }, { from: 4, to: 9.5 }, { from: 9.5, to: 12 }],
  })) as { clips: { start: number; len: number }[] };
  expect(out.clips.map((c) => c.len)).toEqual([4, 5.5, 2.5]);
  expect(out.clips.map((c) => c.start)).toEqual([0, 4, 9.5]);
  expect(useEditor.getState().clips.every((c) => c.assetId === "ref")).toBe(true);
});

test("a run of blocks lays a cut out end to end, storing nothing", async () => {
  const out = (await runAiTool("add_clip", {
    blocks: [
      { seconds: 4, label: "wide of the kitchen" },
      { seconds: 2.5, label: "hands only" },
      { seconds: 6 },
    ],
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
});

test("the whole blockout is one undo step", async () => {
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
  // Without this the blockout comes back as an image with no file: the shot
  // draws nothing, and footage dropped on it inserts beside it instead of
  // filling it.
  expect(saved.find((a) => a.id === "b1")?.block).toEqual({ label: "wide of the kitchen" });
});

test("a swap drops coverage painted for the source it replaces", async () => {
  await runAiTool("add_clip", { asset_id: "mine", start: 0 });
  const clip = useEditor.getState().clips[0]!;
  useEditor.getState().updateClip(clip.id, { mask: { kind: "rect", x: 0, y: 0, w: 0.5, h: 0.5 } });
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

test("a block owns no address and no strip of its own", async () => {
  await runAiTool("add_clip", { blocks: [{ seconds: 4, label: "your photo", color: "#F26722" }] });
  const block = useEditor.getState().assets.find((a) => a.block)!;
  // Nothing to fetch: a url built from an empty file name aims the strip, the
  // preview and the export at a route with no file on the end of it.
  expect(block.url).toBe("");
  expect(block.fileName).toBe("");
  expect(block.thumbs).toBeUndefined();
  // The shot carries the backdrop it stands in for.
  expect(block.block).toEqual({ label: "your photo", color: "#F26722" });
});

test("a block's colour has to be a colour, and says so rather than falling back", async () => {
  // A silent fallback paints a shot the reference never had while the reply
  // reports the backdrop landed.
  const error = await runAiTool("add_clip", {
    blocks: [{ seconds: 2, label: "your photo", color: "orange-ish" }],
  }).then(() => "", (e: unknown) => (e instanceof Error ? e.message : String(e)));
  expect(error).toContain("hex colour");
  expect(useEditor.getState().assets.some((a) => a.block)).toBe(false);
});

test("shorthand is a colour too", async () => {
  await runAiTool("add_clip", { blocks: [{ seconds: 2, label: "your photo", color: "#f50" }] });
  expect(useEditor.getState().assets.find((a) => a.block)!.block).toEqual({
    label: "your photo",
    color: "#ff5500",
  });
});
