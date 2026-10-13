import { beforeEach, expect, test } from "bun:test";
import { runAiTool } from "./aiTools";
import { useEditor } from "./store";

beforeEach(() => {
  useEditor.setState({
    clips: [], overlays: [], transitions: [], audioClips: [],
    assets: [{ id: "voice", fileName: "voice.m4a", name: "Voice", type: "audio", duration: 10, url: "" },
      { id: "music", fileName: "music.m4a", name: "Music", type: "audio", duration: 20, url: "" }],
  });
});

test("assistant can place narration and music together on separate lanes", async () => {
  await runAiTool("add_clip", { asset_id: "voice", start: 0, lane: 0 });
  await runAiTool("add_clip", { asset_id: "music", start: 0, lane: 1 });
  expect(useEditor.getState().audioClips.map((a) => [a.start, a.lane ?? 0])).toEqual([[0, 0], [0, 1]]);
});

test("assistant can set music under narration in one edit", async () => {
  await runAiTool("add_clip", { asset_id: "voice", start: 0 });
  await runAiTool("add_clip", { asset_id: "music", start: 0 });
  const music = useEditor.getState().audioClips.find((a) => a.assetId === "music")!;
  expect([music.start, music.lane]).toEqual([0, 1]);
  await runAiTool("update_audio", { id: music.id, lane: 1, start: 0, volume: 0.15 });
  const repaired = useEditor.getState().audioClips.find((a) => a.id === music.id)!;
  expect([repaired.start, repaired.lane, repaired.volume]).toEqual([0, 1, 0.15]);
});

test("assistant refuses invalid audio lane indices", async () => {
  for (const lane of [-1, 1.5, Infinity]) {
    const error = await runAiTool("add_clip", { asset_id: "music", lane }).catch((cause: unknown) => cause);
    expect(error instanceof Error && error.message.includes("non-negative integer")).toBe(true);
  }
  expect(useEditor.getState().audioClips).toHaveLength(0);
});

// A sound placed at a moment belongs at that moment, on the lowest lane free
// there. Sliding it down lane 0 moved a click off its beat, and the chat then
// opened a lane per sound: a cut with four sounds that never overlap came out
// four soundtrack lanes tall.
test("a sound added at a taken moment with no lane lands there, on the lowest free lane", async () => {
  await runAiTool("add_clip", { asset_id: "voice", start: 0 });
  const res = (await runAiTool("add_clip", { asset_id: "music", start: 2 })) as { lane: number; start: number };
  expect([res.start, res.lane]).toEqual([2, 1]);
});

test("sounds that never overlap share lane 0", async () => {
  await runAiTool("add_clip", { asset_id: "voice", start: 0 });
  await runAiTool("add_clip", { asset_id: "music", start: 12 });
  expect(useEditor.getState().audioClips.map((a) => [a.start, a.lane ?? 0])).toEqual([[0, 0], [12, 0]]);
});

test("a sound put on a higher lane than it needs is told which lane is free", async () => {
  await runAiTool("add_clip", { asset_id: "voice", start: 0 });
  const res = (await runAiTool("add_clip", { asset_id: "music", start: 12, lane: 2 })) as { note?: string; freeLane?: number };
  expect(res.freeLane).toBe(0);
  const id = useEditor.getState().audioClips.find((a) => a.assetId === "music")!.id;
  const moved = (await runAiTool("update_audio", { id, lane: 3 })) as { freeLane?: number };
  expect(moved.freeLane).toBe(0);
  const packed = (await runAiTool("update_audio", { id, lane: 0 })) as { freeLane?: number };
  expect(packed.freeLane).toBeUndefined();
});
